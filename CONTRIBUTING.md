# Contributing to Now Showing

Thanks for considering contributing! This project is a Home Assistant add-on + standalone server for cinema-style now-playing displays.

## Getting Started

1. Fork the repo
2. Clone your fork: `git clone https://github.com/YOUR_USER/now-showing-ha.git`
3. Read `DEV_README.md` for development setup instructions
4. Create a branch: `git checkout -b feature/your-feature`

## Development

- The main kiosk UI is `www/now_showing.html` — a single-file HTML/CSS/JS app
- Server code lives in `server/`
- Add-on packaging in `addons/plex-now-showing/`
- Tests are in `server/test/` — run them with `cd server && npm test`

## Pull Request Process

1. Keep changes focused — one PR per feature/fix
2. Update `addons/plex-now-showing/CHANGELOG.md` under `[Unreleased]`
3. If adding a new config option, update:
   - `addons/plex-now-showing/config.yaml` (add-on schema)
   - `docker/.env.example` or `docker/docker-compose.example.yml` (Docker)
   - `www/now_showing.config.example.js` (frontend-only mode)
   - `server/src/config.js` (server-side config reader)
4. Run `cd server && npm test` to verify tests pass
5. PRs require at least one review before merging

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat: add new feature`
- `fix: correct bug`
- `docs: update documentation`
- `refactor: restructure code`
- `style: visual/UI changes`
- `chore: maintenance tasks`

## Code Style

- HTML: semantic elements, avoid inline styles where practical
- CSS: custom properties for theming, BEM-lite naming
- JS: modern ES2020+, `const`/`let`, async/await, no jQuery
- Server: Node 20+, ES modules
