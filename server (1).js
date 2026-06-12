// server.js
// Reelio backend — stockowe wideo (Pexels) składane w MP4
//
// Zmienne środowiskowe (Railway -> Variables):
//   PEXELS_API_KEY - klucz API z Pexels

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
  const { prompt, aspect = '9:16' } = req.body;
  if (!prompt || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'Prompt jest wymagany.' });
  }
  const jobId = uuidv4();
  jobs.set(jobId, { status: 'queued' });
  res.json({ jobId });
  processJob(jobId, { prompt, aspect }).catch(err => {
    console.error('Job failed:', jobId, err);
    jobs.set(jobId, { status: 'error', error: err.message });
  });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Nie znaleziono zadania.' });
  res.json(job);
});

async function processJob(jobId, { prompt, aspect }) {
  const workDir = path.join(os.tmpdir(), 'reelio-' + jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    jobs.set(jobId, { status: 'pobieranie klipów wideo' });

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

    jobs.set(jobId, { status: 'składanie finalnego filmu' });

    const finalFileName = jobId + '.mp4';
    const finalPath = path.join(OUTPUT_DIR, finalFileName);

    if (videoPaths.length === 1) {
      // Jeden klip — po prostu skopiuj
      await execa('ffmpeg', ['-y', '-i', videoPaths[0], '-c', 'copy', finalPath]);
    } else {
      // Wiele klipów — połącz
      const concatListPath = path.join(workDir, 'concat.txt');
      fs.writeFileSync(concatListPath, videoPaths.map(p => `file '${p}'`).join('\n'));
      await execa('ffmpeg', [
        '-y', '-f', 'concat', '-safe', '0',
        '-i', concatListPath, '-c', 'copy', finalPath
      ]);
    }

    jobs.set(jobId, { status: 'done', videoUrl: '/videos/' + finalFileName });

  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

async function downloadFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Nie udało się pobrać: ' + url);
  fs.writeFileSync(destPath, Buffer.from(await response.arrayBuffer()));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Reelio backend działa na porcie ' + PORT));
