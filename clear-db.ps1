$port = $env:PORT -or "3000"
Invoke-WebRequest -Uri "http://localhost:$port/app/clear-db" -Method Post
