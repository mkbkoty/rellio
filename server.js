// server.js
// Reelio backend — generuje film (stockowe wideo + lektor ElevenLabs + napisy) na podstawie promptu.
//
// Wymagane zmienne środowiskowe (ustaw je w Railway -> Variables):
//   google        - klucz API z Google AI Studio (Gemini) — do scenariusza i napisów
//   elevenlabs    - klucz API z ElevenLabs — do lektora
//   PEXELS_API_KEY - klucz API z Pexels (darmowy) — do stockowych klipów wideo
//
// Wymaga ffmpeg zainstalowanego w środowisku (Railway: nixpacks.toml).

import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { execa } from 'execa';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());
app.use(express.static('.'));

const jobs = new Map();

const OUTPUT_DIR = path.join(process.cwd(), 'public', 'videos');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
app.use('/videos', express.static(OUTPUT_DIR));

// ---------------------------------------------------------
// ENDPOINT: start generowania
// ---------------------------------------------------------
app.post('/api/generate', async (req, res) => {
  const { prompt, voice = 'marek', aspect = '9:16' } = req.body;

  if (!prompt || prompt.trim().length < 5) {
    return res.status(400).json({ error: 'Prompt jest wymagany.' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, { status: 'queued' });
  res.json({ jobId });

  processJob(jobId, { prompt, voice, aspect }).catch(err => {
    console.error('Job failed:', jobId, err);
    jobs.set(jobId, { status: 'error', error: err.message });
  });
});

// ---------------------------------------------------------
// ENDPOINT: status
// ---------------------------------------------------------
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Nie znaleziono zadania.' });
  res.json(job);
});

// ---------------------------------------------------------
// PIPELINE: prompt -> scenariusz (Gemini) -> lektor (ElevenLabs) -> wideo (Pexels) -> MP4
// ---------------------------------------------------------
async function processJob(jobId, { prompt, voice, aspect }) {
  const workDir = path.join(os.tmpdir(), 'reelio-' + jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1) SCENARIUSZ — Gemini generuje narrację i słowa kluczowe do wyszukania wideo
    jobs.set(jobId, { status: 'generowanie scenariusza' });

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.google}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Jesteś twórcą krótkich filmów na TikTok/YouTube Shorts po polsku.
Na podstawie tematu napisz:
1. Narrację do lektora (max 60 słów, angażująca, po polsku)
2. 3 słowa kluczowe po angielsku do wyszukania stockowych klipów wideo (jedno słowo każde)

Temat: ${prompt}

Odpowiedz TYLKO w formacie JSON (bez markdown):
{"narracja": "...", "keywords": ["word1", "word2", "word3"]}`
            }]
          }],
          generationConfig: { temperature: 0.8 }
        })
      }
    );

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Gemini nie zwrócił odpowiedzi.');

    let scenariusz;
    try {
      scenariusz = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch {
      throw new Error('Błąd parsowania odpowiedzi Gemini: ' + rawText);
    }

    const { narracja, keywords } = scenariusz;
    if (!narracja || !keywords?.length) throw new Error('Nieprawidłowy format odpowiedzi Gemini.');

    // 2) LEKTOR — ElevenLabs TTS
    jobs.set(jobId, { status: 'generowanie lektora' });

    const voiceId = mapElevenLabsVoice(voice);
    const elevenRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.elevenlabs,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: narracja,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      }
    );

    if (!elevenRes.ok) {
      const err = await elevenRes.text();
      throw new Error('ElevenLabs error: ' + err);
    }

    const audioPath = path.join(workDir, 'voiceover.mp3');
    const audioBuffer = Buffer.from(await elevenRes.arrayBuffer());
    fs.writeFileSync(audioPath, audioBuffer);

    // 3) NAPISY — generujemy prosty SRT z Gemini (na podstawie narracji)
    jobs.set(jobId, { status: 'generowanie napisów' });

    const srtRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.google}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Podziel poniższy tekst na napisy SRT. Zakładaj tempo ok. 3 słowa na sekundę. Zacznij od 00:00:00,000.
Tekst: ${narracja}

Odpowiedz TYLKO czystym plikiem SRT bez żadnych komentarzy.`
            }]
          }]
        })
      }
    );

    const srtData = await srtRes.json();
    const srtText = srtData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const srtPath = path.join(workDir, 'subtitles.srt');
    fs.writeFileSync(srtPath, srtText.replace(/```srt|```/g, '').trim());

    // 4) WIDEO — pobieramy klipy z Pexels
    jobs.set(jobId, { status: 'pobieranie klipów wideo' });

    const videoPaths = [];
    for (const keyword of keywords) {
      const pexelsRes = await fetch(
        `https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}&per_page=1&orientation=${aspect === '9:16' ? 'portrait' : 'landscape'}`,
        { headers: { Authorization: process.env.PEXELS_API_KEY } }
      );
      const pexelsData = await pexelsRes.json();
      const videoFiles = pexelsData.videos?.[0]?.video_files;
      if (!videoFiles?.length) continue;

      // Wybieramy plik HD lub pierwszy dostępny
      const file = videoFiles.find(f => f.quality === 'hd') || videoFiles[0];
      const clipPath = path.join(workDir, `clip_${keyword}.mp4`);
      await downloadFile(file.link, clipPath);
      videoPaths.push(clipPath);
    }

    if (!videoPaths.length) throw new Error('Nie udało się pobrać żadnych klipów z Pexels.');

    // 5) SKŁADANIE — łączymy klipy, dodajemy audio i napisy
    jobs.set(jobId, { status: 'składanie finalnego filmu' });

    // Tworzymy listę klipów dla ffmpeg concat
    const concatListPath = path.join(workDir, 'concat.txt');
    const concatContent = videoPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent);

    const mergedVideoPath = path.join(workDir, 'merged.mp4');

    // Łączymy klipy
    await execa('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      mergedVideoPath
    ]);

    const finalFileName = jobId + '.mp4';
    const finalPath = path.join(OUTPUT_DIR, finalFileName);

    // Dodajemy lektor + napisy
    await execa('ffmpeg', [
      '-y',
      '-stream_loop', '-1',   // zapętla wideo jeśli audio jest dłuższe
      '-i', mergedVideoPath,
      '-i', audioPath,
      '-vf', `subtitles=${srtPath}:force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,Bold=1,OutlineColour=&H00000000,Outline=2'`,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-shortest',
      finalPath
    ]);

    jobs.set(jobId, {
      status: 'done',
      videoUrl: '/videos/' + finalFileName,
      narracja
    });

  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function downloadFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Nie udało się pobrać pliku: ' + url);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

function mapElevenLabsVoice(voiceName) {
  // Domyślne głosy ElevenLabs — możesz zmienić ID na swoje z panelu ElevenLabs
  const map = {
    marek: 'pNInz6obpgDQGcFmaJgB',   // Adam — męski, neutralny
    ania: 'EXAVITQu4vr4xnSDxMaL',    // Bella — żeński
    default: 'pNInz6obpgDQGcFmaJgB'
  };
  return map[voiceName] || map.default;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Reelio backend działa na porcie ' + PORT));
