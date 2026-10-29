# Models feature targets. Run from the repo root:
#   make -f scripts/models.mk test-models
# Kept out of the root Makefile on purpose (the worker branch owns that file).
.PHONY: test-models lint-models

test-models:
	bash tests/models/run.sh

lint-models:
	bash -n scripts/download-models.sh
	@if command -v shellcheck >/dev/null; then \
	  shellcheck scripts/download-models.sh tests/models/run.sh; \
	else \
	  echo "shellcheck not installed: skipped (only bash -n ran). Install: pip install shellcheck-py"; \
	fi
