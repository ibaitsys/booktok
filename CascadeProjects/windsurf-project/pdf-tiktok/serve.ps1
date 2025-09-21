param(
  [int]$Port = 3000,
  [string]$Root = "."
)

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Serving '$Root' at $prefix (Press Ctrl+C to stop)"

function Get-ContentType([string]$Path) {
  switch ([IO.Path]::GetExtension($Path).ToLower()) {
    ".html" { return "text/html" }
    ".js"   { return "text/javascript" }
    ".mjs"  { return "text/javascript" }
    ".css"  { return "text/css" }
    ".json" { return "application/json" }
    ".svg"  { return "image/svg+xml" }
    ".png"  { return "image/png" }
    ".jpg"  { return "image/jpeg" }
    ".jpeg" { return "image/jpeg" }
    ".ico"  { return "image/x-icon" }
    default  { return "application/octet-stream" }
  }
}

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    $localPath = $request.Url.LocalPath.TrimStart('/')
    if ([string]::IsNullOrWhiteSpace($localPath)) { $localPath = "index.html" }
    $filePath = Join-Path -Path $Root -ChildPath $localPath

    if (Test-Path -LiteralPath $filePath -PathType Leaf) {
      try {
        $bytes = [IO.File]::ReadAllBytes($filePath)
        $response.ContentType = Get-ContentType $filePath
        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.StatusCode = 200
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      } catch {
        $err = "Server error: $($_.Exception.Message)"
        $bytes = [Text.Encoding]::UTF8.GetBytes($err)
        $response.StatusCode = 500
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } else {
      $bytes = [Text.Encoding]::UTF8.GetBytes("Not Found")
      $response.StatusCode = 404
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    }

    $response.Close()
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
