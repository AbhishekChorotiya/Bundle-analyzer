#!/usr/bin/env bash
# Shim — delegates to Node.js orchestrator.
# See scripts/orchestrate.js for the actual implementation.
exec node "$(dirname "$0")/scripts/orchestrate.js" "$@"
