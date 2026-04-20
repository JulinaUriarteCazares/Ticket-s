$pwd = pwd
Write-Host "Current directory: $pwd"

# Start server
Write-Host "Starting server..."
$proc = Start-Process node -ArgumentList "index.js" -PassThru -NoNewWindow
Start-Sleep -Seconds 2

# Login
Write-Host "Logging in..."
$loginBody = @{ email = 'Admin@gmail.com'; password = '1234' } | ConvertTo-Json
$login = Invoke-RestMethod -Uri 'http://localhost:3000/api/auth/login' -Method Post -ContentType 'application/json' -Body $loginBody
$token = $login.token
Write-Host "Token obtained: $($token.Substring(0, 20))..."

# Get events
Write-Host "Getting events..."
$headers = @{ Authorization = "Bearer $token" }
$events = Invoke-RestMethod -Uri 'http://localhost:3000/api/events' -Method Get -Headers $headers
$eventId = $events[0].id
Write-Host "First event ID: $eventId"

# Get admin report
Write-Host "Getting admin report..."
$report = Invoke-RestMethod -Uri "http://localhost:3000/api/events/$eventId/admin-report" -Method Get -Headers $headers

Write-Host "=== TRENDS DATA ===" 
Write-Host ($report.trends | ConvertTo-Json -Depth 10)

# Stop server
Stop-Process -InputObject $proc -Force
Write-Host "Server stopped"
