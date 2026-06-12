# HIIT Timer

A Progressive Web App (PWA) interval timer for Android (and any modern browser). No app store required — install directly from Chrome.

## Features

- **Create and delete workouts** — give each workout a name and build any sequence of intervals
- **Flexible intervals** — each interval has a label (e.g. "Work", "Rest") and a duration in seconds
- **Optional lead-in** — a configurable countdown before the first interval starts
- **Warning tones** — short beeps at 3, 2, and 1 second before each interval ends; a distinct tone plays at the moment of change
- **Background audio** — tones play even when the screen is off or you switch apps; all remaining beeps are pre-scheduled via the Web Audio API when the app goes to background
- **Wake lock** — requests a screen wake lock while a workout is running to keep the display on

## Installing on Android

1. Host the files over HTTPS (see [Deployment](#deployment))
2. Open the URL in Chrome on Android
3. Tap **Add to Home Screen** in the browser menu (or accept the install banner)

The app then runs fullscreen from your home screen like a native app.

## Deployment

Any static file host works. Quickest options:

```bash
# Local network (no HTTPS — PWA install won't work, but the timer will)
python3 -m http.server 8080

# Vercel
npx vercel

# GitHub Pages — push to main, enable Pages in repo settings
```

For PWA install on Android, the site must be served over HTTPS.

## How it works

**Timer accuracy:** The countdown display is driven by `requestAnimationFrame` using `Date.now()` as the time source, so it stays correct after the screen wakes back up from sleep.

**Background tones:** Audio is scheduled using `AudioContext` absolute timestamps (`audioContext.currentTime + offset`). Pre-scheduled Web Audio events fire even when the browser tab is suspended by the OS. When the page is hidden (screen off or app switched), all remaining tones for the workout are scheduled immediately to ensure they play on time regardless of JS throttling.

**Storage:** Workouts are saved in `localStorage` — no server or account needed.

## Project structure

```
index.html    — app shell, three views (list / edit / timer)
styles.css    — dark theme, mobile-first layout
app.js        — storage, audio engine, timer logic, view management
sw.js         — service worker (cache-first, enables offline use)
manifest.json — PWA metadata
icon.svg      — app icon
```
