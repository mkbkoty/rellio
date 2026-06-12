# Reelio — Generator filmów AI (Shorts / TikTok)

Strona + backend generujący filmy AI z lektorem i napisami, na podstawie promptu tekstowego.

## Co jest w tym repo

- `index.html` — strona Reelio (frontend), z formularzem generowania filmu
- `server.js` — backend Node.js (Express), który:
  1. generuje wideo przez **fal.ai** (model Seedance/Veo)
  2. generuje lektora przez **OpenAI TTS**
  3. generuje napisy przez **OpenAI Whisper**
  4. składa wszystko w jeden plik MP4 przy użyciu **ffmpeg**
- `package.json` — lista zależności
- `nixpacks.toml` — konfiguracja dla Railway (zapewnia dostęp do ffmpeg)
- `.env.example` — przykładowe zmienne środowiskowe

## Wymagane klucze API

1. **fal.ai** — zarejestruj się na https://fal.ai, w panelu znajdziesz klucz API (zaczyna się od czegoś w stylu `key_id:key_secret`)
2. **OpenAI** — https://platform.openai.com/api-keys

## Deploy na Railway (krok po kroku)

1. Wgraj zawartość tego folderu do repozytorium na GitHub (np. `reelio-app`)
   - **NIE wgrywaj** pliku `.env` — jest w `.gitignore`
2. Wejdź na https://railway.app i zaloguj się przez GitHub
3. Kliknij **New Project → Deploy from GitHub repo** i wybierz swoje repo
4. Railway automatycznie wykryje `package.json` i `nixpacks.toml`, zainstaluje zależności i odpali `npm start`
5. Wejdź w zakładkę **Variables** projektu i dodaj:
   - `FAL_KEY` = twój klucz z fal.ai
   - `OPENAI_API_KEY` = twój klucz z OpenAI
6. Railway przydzieli publiczny adres (np. `reelio-app.up.railway.app`) — wejdź na zakładkę **Settings → Networking → Generate Domain**, jeśli nie jest jeszcze widoczny
7. Otwórz ten adres w przeglądarce — powinna pojawić się strona Reelio. Wpisz prompt i kliknij "Generuj film"

## Jak to działa po stronie użytkownika

1. Użytkownik wpisuje prompt i klika "Generuj film"
2. Frontend wysyła `POST /api/generate` → backend zwraca `jobId` i zaczyna pracować w tle
3. Frontend co 4 sekundy odpytuje `GET /api/status/:jobId`
4. Gdy status to `done`, pojawia się link do gotowego pliku MP4 (`/videos/<jobId>.mp4`)

## Ograniczenia obecnej wersji (do rozwoju)

- **Długość filmu**: model wideo (Seedance Lite) generuje krótkie segmenty (do ~10s).
  Dla filmów 30/60/90s trzeba:
  - wygenerować kilka segmentów wideo (różne prompty/sceny)
  - skleić je przez ffmpeg (`concat`) **przed** dołożeniem audio i napisów
  - Obecny kod generuje jeden krótki segment — to wersja demonstracyjna pipeline'u

- **Przechowywanie statusów zadań** (`jobs = new Map()`) jest w pamięci procesu —
  przy restarcie serwera lub wielu instancjach (skalowanie) trzeba przenieść to
  do bazy danych (np. Redis, Postgres)

- **Pliki wideo** są zapisywane lokalnie w `public/videos/` — przy większej skali
  warto przenieść je do storage (np. Cloudflare R2, S3) i zwracać link tam

- **Koszty**: każde wywołanie `/api/generate` realnie kosztuje (fal.ai + OpenAI).
  Przed produkcją dodaj limity / autoryzację użytkowników, żeby ktoś nie
  generował filmów bez ograniczeń na Twój koszt.

## Test lokalny

```bash
npm install
cp .env.example .env   # i wpisz swoje klucze
npm start
```

Wymaga zainstalowanego ffmpeg lokalnie (np. `brew install ffmpeg` / `apt install ffmpeg`).
Strona będzie dostępna na `http://localhost:3000`.
