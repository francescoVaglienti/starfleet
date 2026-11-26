#!/bin/sh
set -eu
exec python3 "$(dirname "$0")/export_public.py" "$@"
