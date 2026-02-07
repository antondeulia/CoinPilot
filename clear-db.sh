#!/bin/bash

PORT=${PORT:-3000}
curl -X POST http://localhost:$PORT/app/clear-db
