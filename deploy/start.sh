#!/bin/bash
export PATH="@PATH@"
set -a
source @ENV_PATH@
set +a
exec @BIN_PATH@
