# Filter Database Builder - Progress Monitor
# Checks progress every 5 minutes and displays stats

Write-Host "=" -NoNewline -ForegroundColor Cyan
Write-Host ("="*59) -ForegroundColor Cyan
Write-Host "FILTER DATABASE BUILDER - PROGRESS MONITOR" -ForegroundColor Cyan
Write-Host ("="*60) -ForegroundColor Cyan
Write-Host ""

$totalDatasets = 7616
$startTime = Get-Date

function Get-Stats {
    if (Test-Path "dataset_filters.json") {
        $content = Get-Content "dataset_filters.json" | ConvertFrom-Json
        $total = ($content.PSObject.Properties | Measure-Object).Count
        $nodata = ($content.PSObject.Properties | Where-Object { $_.Value._no_data -eq $true } | Measure-Object).Count
        $hasdata = $total - $nodata
        
        return @{
            Total = $total
            HasData = $hasdata
            NoData = $nodata
            Percent = [math]::Round($total/$totalDatasets*100, 1)
        }
    }
    return $null
}

$iteration = 0
$lastTotal = 0

while ($true) {
    $iteration++
    $now = Get-Date
    $elapsed = $now - $startTime
    
    Write-Host ""
    Write-Host "[$($now.ToString('HH:mm:ss'))] Check #$iteration" -ForegroundColor Yellow
    Write-Host ("-"*60) -ForegroundColor DarkGray
    
    $stats = Get-Stats
    
    if ($stats) {
        $remaining = $totalDatasets - $stats.Total
        
        # Calculate rate
        if ($iteration -gt 1 -and $lastTotal -gt 0) {
            $processed = $stats.Total - $lastTotal
            $rate = $processed * 12  # per hour (5 min intervals)
            $hoursLeft = if ($rate -gt 0) { [math]::Round($remaining / $rate, 1) } else { 0 }
        } else {
            $rate = 0
            $hoursLeft = 0
        }
        
        Write-Host "Progress:      $($stats.Total) / $totalDatasets datasets ($($stats.Percent)%)" -ForegroundColor White
        Write-Host "  With Data:   " -NoNewline -ForegroundColor Gray
        Write-Host "$($stats.HasData)" -ForegroundColor Green -NoNewline
        Write-Host " ($([math]::Round($stats.HasData/$stats.Total*100, 1))%)" -ForegroundColor Gray
        Write-Host "  No Data:     " -NoNewline -ForegroundColor Gray
        Write-Host "$($stats.NoData)" -ForegroundColor Red -NoNewline
        Write-Host " ($([math]::Round($stats.NoData/$stats.Total*100, 1))%)" -ForegroundColor Gray
        
        if ($iteration -gt 1) {
            Write-Host ""
            Write-Host "Rate:          $rate datasets/hour" -ForegroundColor Cyan
            Write-Host "Remaining:     $remaining datasets" -ForegroundColor Cyan
            Write-Host "Est. Complete: $hoursLeft hours" -ForegroundColor Cyan
        }
        
        Write-Host ""
        Write-Host "Elapsed Time:  $($elapsed.Hours)h $($elapsed.Minutes)m" -ForegroundColor Magenta
        
        $lastTotal = $stats.Total
        
        # Check if complete
        if ($stats.Total -ge $totalDatasets) {
            Write-Host ""
            Write-Host ("="*60) -ForegroundColor Green
            Write-Host "COMPLETE!" -ForegroundColor Green
            Write-Host ("="*60) -ForegroundColor Green
            Write-Host ""
            Write-Host "Final Stats:" -ForegroundColor White
            Write-Host "  Total:       $($stats.Total)" -ForegroundColor White
            Write-Host "  With Data:   $($stats.HasData) ($([math]::Round($stats.HasData/$stats.Total*100, 1))%)" -ForegroundColor Green
            Write-Host "  No Data:     $($stats.NoData) ($([math]::Round($stats.NoData/$stats.Total*100, 1))%)" -ForegroundColor Red
            Write-Host "  Total Time:  $($elapsed.Hours)h $($elapsed.Minutes)m" -ForegroundColor Magenta
            Write-Host ""
            break
        }
    } else {
        Write-Host "Waiting for database file to be created..." -ForegroundColor Yellow
    }
    
    Write-Host ""
    Write-Host "Next check in 5 minutes..." -ForegroundColor DarkGray
    Write-Host ""
    
    # Wait 5 minutes
    Start-Sleep -Seconds 300
}

Write-Host "Monitor stopped." -ForegroundColor Gray
