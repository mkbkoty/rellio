// server.js
// Reelio backend — generuje film AI (wideo + lektor + napisy) na podstawie promptu.
//
// Wymagane zmienne środowiskowe (ustaw je w Railway -> Variables):
//   FAL_KEY        - klucz API z fal.ai (do generowania wideo, np. Seedance / Veo)
//   OPENAI_API_KEY - klucz API z OpenAI (TTS + Whisper)
//
// Wymaga ffmpeg zainstalowanego w środowisku (Railway: dodaj nixpacks.toml, patrz README).

import express from 'express';
import { fal } from '@fal-ai/client';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { execa } from 'execa';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());
app.use(express.static('.')); // serwuje index.html i pliki statyczne

// Konfiguracja klientów API
fal.config({ credentials: process.env.FAL_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Prosta pamięć na statusy zadań (w produkcji: użyj bazy danych / Redis)
const jobs = new Map();

const OUTPUT_DIR = path.join(process.cwd(), 'public', 'videos');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use('/videos', express.static(OUTPUT_DIR));

// ---------------------------------------------------------
// ENDPOINT: start generowania
// ---------------------------------------------------------
app.post('/api/generate', async (req, res) => {
  const { prompt, duration = 30, voice = 'alloy', aspect = '9:16' } = req.body;

  if (!prompt || prompt.trim().length < 5) {
    return res.status(400).json({ error: 'Prompt jest wymagany.' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, { status: 'queued' });

  // Odpowiadamy natychmiast, przetwarzanie w tle
  res.json({ jobId });

  processJob(jobId, { prompt, duration, voice, aspect }).catch(err => {
    console.error('Job failed:', jobId, err);
    jobs.set(jobId, { status: 'error', error: err.message });
  });
});

// ---------------------------------------------------------
// ENDPOINT: sprawdzenie statusu
// ---------------------------------------------------------
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Nie znaleziono zadania.' });
  res.json(job);
});

// ---------------------------------------------------------
// GŁÓWNY PIPELINE: prompt -> wideo + lektor + napisy -> MP4
// ---------------------------------------------------------
async function processJob(jobId, { prompt, duration, voice, aspect }) {
  const workDir = path.join(os.tmpdir(), 'reelio-' + jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1) WIDEO — generujemy bazowy klip przez fal.ai (np. model Seedance / Veo)
    jobs.set(jobId, { status: 'generowanie wideo' });

    const videoResult = await fal.subscribe('fal-ai/bytedance/seedance/v1/lite/text-to-video', {
      input: {
        prompt: prompt,
        aspect_ratio: aspect,        // np. "9:16"
        duration: Math.min(duration, 10) // model generuje krótkie segmenty; dłuższe = pętla/łączenie
      },
      logs: false
    });

    const videoUrl = videoResult?.data?.video?.url;
    if (!videoUrl) throw new Error('Brak adresu wygenerowanego wideo.');

    const rawVideoPath = path.join(workDir, 'raw_video.mp4');
    await downloadFile(videoUrl, rawVideoPath);

    // 2) LEKTOR — generujemy narrację z OpenAI TTS na podstawie promptu/scenariusza
    jobs.set(jobId, { status: 'generowanie lektora' });

    const ttsResponse = await openai.audio.speech.create({
      model: 'tts-1',
      voice: mapVoice(voice), // np. "onyx", "alloy", "nova"
      input: prompt
    });

    const audioPath = path.join(workDir, 'voiceover.mp3');
    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
    fs.writeFileSync(audioPath, audioBuffer);

    // 3) NAPISY — transkrypcja audio przez Whisper -> plik SRT z timestampami
    jobs.set(jobId, { status: 'generowanie napisów' });

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'srt'
    });

    const srtPath = path.join(workDir, 'subtitles.srt');
    fs.writeFileSync(srtPath, transcription); // transcription = string SRT

    // 4) SKŁADANIE — ffmpeg: wideo + audio + napisy -> finalny MP4
    jobs.set(jobId, { status: 'składanie finalnego filmu' });

    const finalFileName = jobId + '.mp4';
    const finalPath = path.join(OUTPUT_DIR, finalFileName);

    // Uwaga: jeśli wideo z fal.ai jest krótsze niż audio, ffmpeg przyciągnie
    // długość do najkrótszego strumienia (-shortest). Dla dłuższych filmów
    // trzeba wygenerować kilka segmentów wideo i skleić je przed tym krokiem.
    await execa('ffmpeg', [
      '-y',
      '-i', rawVideoPath,
      '-i', audioPath,
      '-vf', `subtitles=${srtPath}:force_style='FontName=Outfit,FontSize=22,PrimaryColour=&H0080C9FF,Bold=1'`,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-shortest',
      finalPath
    ]);

    jobs.set(jobId, {
      status: 'done',
      videoUrl: '/videos/' + finalFileName
    });

  } finally {
    // Czyszczenie plików tymczasowych
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

// Pomocnicze: pobranie pliku z URL na dysk
async function downloadFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Nie udało się pobrać pliku: ' + url);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

// Mapowanie nazw głosów z frontendu na głosy OpenAI TTS
function mapVoice(voiceName) {
  const map = {
    marek: 'onyx',
    ania: 'nova',
    default: 'alloy'
  };
  return map[voiceName] || map.default;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Reelio backend działa na porcie ' + PORT));
