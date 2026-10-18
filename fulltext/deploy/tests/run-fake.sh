#!/bin/bash
# 假的 run-service.sh：交给 fake_service.py
exec python3 "$(dirname "$0")/fake_service.py"
