# Reproduce the checked-in Windows icon from Z's geometric wordmark.
Add-Type -AssemblyName System.Drawing
$assetDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\renderer\assets'))
$bitmap = [Drawing.Bitmap]::new(256, 256)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([Drawing.Color]::Transparent)
$graphics.ScaleTransform(256 / 96, 256 / 96)
$background = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#181b19'))
$accent = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#ccf777'))
$outline = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#41483e'), 1)
$shape = [Drawing.Drawing2D.GraphicsPath]::new()
$shape.AddArc(1, 1, 48, 48, 180, 90)
$shape.AddArc(47, 1, 48, 48, 270, 90)
$shape.AddArc(47, 47, 48, 48, 0, 90)
$shape.AddArc(1, 47, 48, 48, 90, 90)
$shape.CloseFigure()
try {
  $graphics.FillPath($background, $shape)
  $graphics.DrawPath($outline, $shape)
  $points = [Drawing.PointF[]]@(
    [Drawing.PointF]::new(27,28), [Drawing.PointF]::new(70,28),
    [Drawing.PointF]::new(40,58), [Drawing.PointF]::new(69,58),
    [Drawing.PointF]::new(69,68), [Drawing.PointF]::new(24,68),
    [Drawing.PointF]::new(54,38), [Drawing.PointF]::new(27,38)
  )
  $graphics.FillPolygon($accent, $points)
  $graphics.FillEllipse($accent, 70, 18, 8, 8)
  $pngPath = Join-Path $assetDirectory 'z-icon.png'
  $bitmap.Save($pngPath, [Drawing.Imaging.ImageFormat]::Png)
  $png = [IO.File]::ReadAllBytes($pngPath)
  $stream = [IO.File]::Create((Join-Path $assetDirectory 'z-icon.ico'))
  $writer = [IO.BinaryWriter]::new($stream)
  try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
    $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$png.Length); $writer.Write([uint32]22); $writer.Write($png)
  } finally { $writer.Dispose(); $stream.Dispose() }
} finally {
  $graphics.Dispose(); $bitmap.Dispose(); $background.Dispose(); $accent.Dispose(); $outline.Dispose(); $shape.Dispose()
}
