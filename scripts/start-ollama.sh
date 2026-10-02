#!/usr/bin/env bash
# Start Ollama for MangoGPT: loopback only, several answers generated in parallel.
#
# OLLAMA_NUM_PARALLEL: answers generated at the same time. With the default (1) people queue one behind
# another; on this GPU 4 slots raised total throughput about 2.7x and cut the wait for 4 simultaneous
# askers from ~3 s to ~0.5 s, at the cost of ~2.5 GiB more GPU memory (gemma4:12b, 8k context).
# Memory grows with (slots x context length), so lower it if you raise the context length in Settings.
export PATH="$HOME/.local/ollama/bin:$PATH"
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
export OLLAMA_MODELS="${OLLAMA_MODELS:-$HOME/ollama-data}"
export OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-4}"
exec ollama serve
