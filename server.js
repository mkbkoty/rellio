// server.js
// Reelio backend — stockowe wideo (Pexels) + lektor (ElevenLabs) + napisy (ffmpeg)
//
// Zmienne środowiskowe (Railway -> Variables):
//   elevenlabs    - klucz API z ElevenLabs
//   PEXELS_API_KEY - klucz API z Pexels (darmowy: pexels.com/api)

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

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Nie znaleziono zadania.' });
  res.json(job);
});

async function processJob(jobId, { prompt, voice, aspect }) {
  const workDir = path.join(os.tmpdir(), 'reelio-' + jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1) WIDEO — pobieramy klipy z Pexels na podstawie promptu
    jobs.set(jobId, { status: 'pobieranie klipów wideo' });

    // Bierzemy pierwsze 3 słowa z promptu jako słowa kluczowe
    const keywords = prompt.trim().split(/\s+/).slice(0, 3);
    const videoPaths = [];

    for (const keyword of keywords) {
      try {
        const pexelsRes = await fetch(
          `https://api.pexels.com/videos/search?query=${encodeURIComponent(keyword)}&per_page=1&orientation=${aspect === '9:16' ? 'portrait' : 'landscape'}`,
          { headers: { Authorization: process.env.PEXELS_API_KEY } }
        );
        const pexelsData = await pexelsRes.json();
        const videoFiles = pexelsData.videos?.[0]?.video_files;
        if (!videoFiles?.length) continue;
        const file = videoFiles.find(f => f.quality === 'hd') || videoFiles[0];
        const clipPath = path.join(workDir, `clip_${keyword}.mp4`);
        await downloadFile(file.link, clipPath);
        videoPaths.push(clipPath);
      } catch(e) {
        console.warn('Pexels clip failed for:', keyword, e.message);
      }
    }

    if (!videoPaths.length) throw new Error('Nie udało się pobrać żadnych klipów z Pexels.');

    // 2) LEKTOR — ElevenLabs czyta prompt bezpośrednio
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
          text: prompt,
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

    // 3) SKŁADANIE — łączymy klipy + audio
    jobs.set(jobId, { status: 'składanie finalnego filmu' });

    const concatListPath = path.join(workDir, 'concat.txt');
    fs.writeFileSync(concatListPath, videoPaths.map(p => `file '${p}'`).join('\n'));

    const mergedVideoPath = path.join(workDir, 'merged.mp4');
    await execa('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', concatListPath, '-c', 'copy', mergedVideoPath
    ]);

    const finalFileName = jobId + '.mp4';
    const finalPath = path.join(OUTPUT_DIR, finalFileName);

    await execa('ffmpeg', [
      '-y',
      '-stream_loop', '-1',
      '-i', mergedVideoPath,
      '-i', audioPath,
      '-vf', `drawtext=text='':fontsize=1`,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-shortest',
      finalPath
    ]);

    jobs.set(jobId, { status: 'done', videoUrl: '/videos/' + finalFileName });

  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function downloadFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Nie udało się pobrać pliku: ' + url);
  fs.writeFileSync(destPath, Buffer.from(await response.arrayBuffer()));
}

function mapElevenLabsVoice(voiceName) {
  const map = {
    marek: 'pNInz6obpgDQGcFmaJgB',
    ania: 'EXAVITQu4vr4xnSDxMaL',
    default: 'pNInz6obpgDQGcFmaJgB'
  };
  return map[voiceName] || map.default;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Reelio backend działa na porcie ' + PORT));
