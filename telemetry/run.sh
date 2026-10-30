#!/usr/bin/env bash
# Rebuilds (dist/ and public/js/ aren't committed) and starts the server. Used by the @reboot crontab entry.
set -e
cd "$(dirname "$0")"
# Single-threaded, memory-capped tsc: the default can exhaust RAM on this box.
GOMEMLIMIT=250MiB npm run build
exec npm start
