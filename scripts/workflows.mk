# Workflow checks.  Use:  make -f scripts/workflows.mk <target>
#   test-workflows      static checks, no docker (needs scripts/models.lock)
#   validate-workflows  docker: ComfyUI --cpu in the worker image, lint + /prompt
#   build-workflows     regenerate workflows/*.json from scripts/build-workflows.py
# Variables: IMAGE, HANDLER, LOCK (see scripts/validate-workflows.sh)
MK_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
ROOT   := $(abspath $(MK_DIR)/..)
LOCK   ?= $(ROOT)/scripts/models.lock

.PHONY: test-workflows validate-workflows build-workflows

test-workflows:
	python3 $(MK_DIR)check_workflows.py static --workflows $(ROOT)/workflows \
		--lock $(LOCK) --readme $(ROOT)/workflows/README.md

validate-workflows: test-workflows
	LOCK=$(LOCK) $(MK_DIR)validate-workflows.sh

build-workflows:
	python3 $(MK_DIR)build-workflows.py
