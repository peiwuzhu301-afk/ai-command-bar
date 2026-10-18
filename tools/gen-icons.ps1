# Generate a valid multi-image ICO with proper V3 BITMAPINFOHEADER.
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'src-tauri\resources'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$icoPath = Join-Path $outDir "icon.ico"

$white = [System.Drawing.Color]::White
$blue  = [System.Drawing.Color]::FromArgb(255, 42, 80, 150)

function BuildIco([System.Drawing.Size[]]$sims) {
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)

    # ICONDIR header
    $bw.Write([uint16]0)              # reserved
    $bw.Write([uint16]1)              # type: 1 = icon
    $bw.Write([uint16]$sims.Count)    # count

    $sizeList = @()
    $offsetList = @()
    $imageBlobs = @()
    $offset = 6 + 16 * $sims.Count

    for ($i = 0; $i -lt $sims.Count; $i++) {
        $s = $sims[$i]
        $w = $s.Width; $h = $s.Height
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = "AntiAlias"
        $g.Clear([System.Drawing.Color]::FromArgb(0,0,0,0))
        $rect = New-Object System.Drawing.Rectangle 1,1,([int]($w-2)),([int]($h-2))
        $bg = New-Object System.Drawing.SolidBrush $blue
        $g.FillRectangle($bg, $rect)
        $fg = New-Object System.Drawing.SolidBrush $white
        $pad = [int]($w * 0.22); $barW = [int]([Math]::Max(1, $w*0.09)); $barH = [int]($h*0.56)
        $g.FillRectangle($fg, $pad, $pad, $barW, $barH)
        $g.FillRectangle($fg, ([int]($w-$pad-$barW)), $pad, $barW, $barH)
        $midY = $pad + [int]($barH*0.5)
        $g.FillRectangle($fg, $pad, $midY, ([int]($w-2*$pad-$barW)), $barW)
        $g.Dispose()

        # Build an ICO entry: BITMAPINFOHEADER + bottom-up BGRA pixel data + AND mask
        $msIll = New-Object System.IO.MemoryStream
        # BITMAPINFOHEADER (40 bytes)
        $msIll.Write([byte[]]@(40,0,0,0), 0, 4)               # biSize
        $msIll.Write([BitConverter]::GetBytes([int]$w), 0, 4)  # biWidth
        $msIll.Write([BitConverter]::GetBytes([int]($h*2)), 0, 4) # biHeight (2x for XOR+AND)
        $msIll.Write([byte[]]@(1,0), 0, 2)                    # biPlanes
        $msIll.Write([byte[]]@(32,0), 0, 2)                   # biBitCount
        $msIll.Write([byte[]]@(0,0,0,0), 0, 4)                # biCompression = 0 (BI_RGB)
        # biSizeImage
        $imgBytes = $w * $h * 4 + [int](($w * $h / 8))        # XOR + AND mask size (approx)
        $msIll.Write([BitConverter]::GetBytes([int]$imgBytes), 0, 4)
        $msIll.Write([byte[]]@(0,0,0,0), 0, 8)                # biXPelsPerMeter..biClrUsage
        $msIll.Write([byte[]]@(0,0,0,0), 0, 4)

        # XOR data: bottom-up BGRA
        for ($y = $h - 1; $y -ge 0; $y--) {
            for ($x = 0; $x -lt $w; $x++) {
                $c = $bmp.GetPixel($x, $y)
                $msIll.Write($c.B); $msIll.Write($c.G); $msIll.Write($c.R); $msIll.Write($c.A)
            }
        }
        # AND mask: all zeros (transparent = ignore) padded to 32-bit rows
        $rowBytes = [int](($w + 31) / 32) * 4
        $zeroRow = New-Object byte[] $rowBytes
        for ($y = 0; $y -lt $h; $y++) {
            $msIll.Write($zeroRow, 0, $rowBytes)
        }
        $bmp.Dispose()

        $imageBlobs += $msIll.ToArray()
        $sizeList += $imageBlobs[$imageBlobs.Count - 1].Length
        $offsetList += $offset
        $offset += $imageBlobs[$imageBlobs.Count - 1].Length
    }

    # Now write ICODIR entries
    for ($i = 0; $i -lt $sims.Count; $i++) {
        $bw.Write([byte]$(if ($sims[$i].Width -ge 256) { 0 } else { $sims[$i].Width }))
        $bw.Write([byte]$(if ($sims[$i].Height -ge 256) { 0 } else { $sims[$i].Height }))
        $bw.Write([byte]0)   # colors in palette
        $bw.Write([byte]0)   # reserved
        $bw.Write([uint16]1) # color planes
        $bw.Write([uint16]32)# bpp
        $bw.Write([uint32]$sizeList[$i])
        $bw.Write([uint32]$offsetList[$i])
    }

    # Now that offsets were written based on [$offset] BEFORE image blobs, append the images
    for ($i = 0; $i -lt $imageBlobs.Count; $i++) {
        $bw.Write($imageBlobs[$i])
    }

    return $ms.ToArray()
}

$sizes = @(
  (New-Object System.Drawing.Size 16,16),
  (New-Object System.Drawing.Size 32,32),
  (New-Object System.Drawing.Size 48,48),
  (New-Object System.Drawing.Size 256,256)
)
$ico = BuildIco $sizes
[System.IO.File]::WriteAllBytes($icoPath, $ico)
Write-Host "Wrote $icoPath ($($ico.Length) bytes)"
