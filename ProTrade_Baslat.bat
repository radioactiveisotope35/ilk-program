@echo off
title ProTrade Smart Launcher
color 0B
cls
echo ========================================================
echo       PROTRADE OTOMATIK KURULUM VE BASLATMA ARACI
echo              V9.4 - Chrome App Mode Edition
echo ========================================================
echo.

:: --- AYARLAR (Dosya Yolunu Buradan Alir) ---
set "ANA_KLASOR=%~dp0"
:: (Not: %~dp0 bu dosyanin oldugu klasoru otomatik bulur)
:: Eger BAT dosyasini projenin icine degil de masaustune koyduysaniz
:: asagidaki satirin basindaki "REM" isaretini silin ve yolu duzeltin:
set "ANA_KLASOR=C:\Users\aserd\Desktop\protrade-app"

set "SERVER_KLASOR=%ANA_KLASOR%\server"
set "URL=http://localhost:3000"

:: ═══════════════════════════════════════════════════════════════════════════════
:: CHROME APP MODE - MAKSIMUM PERFORMANS FLAGS
:: Arka plan throttling tamamen devre disi, WebSocket her zaman aktif
:: ═══════════════════════════════════════════════════════════════════════════════
set CHROME_FLAGS=^
--app=%URL% ^
--disable-background-timer-throttling ^
--disable-backgrounding-occluded-windows ^
--disable-renderer-backgrounding ^
--disable-background-networking ^
--disable-ipc-flooding-protection ^
--disable-hang-monitor ^
--disable-component-update ^
--disable-breakpad ^
--disable-features=IntensiveWakeUpThrottling,ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes ^
--enable-features=NetworkService,NetworkServiceInProcess ^
--force-fieldtrials=BackgroundTabTimerThrottling/disabled ^
--js-flags="--max-old-space-size=4096" ^
--window-size=1400,900 ^
--window-position=100,50

echo [BILGI] Calisma Dizini: %ANA_KLASOR%
echo [BILGI] Chrome App Mode: AKTIF (Arka Plan Throttling KAPALI)
echo.

:: 1. BACKEND KONTROL VE BASLATMA
echo [1/4] Backend (Motor) Kontrol Ediliyor...
if exist "%SERVER_KLASOR%" (
    if not exist "%SERVER_KLASOR%\node_modules" (
        echo [UYARI] Backend kutuphaneleri eksik! Ilk kurulum yapiliyor...
        echo Lutfen bekleyin, bu islem bir kez yapilir.
        cmd /c "cd /d %SERVER_KLASOR% && npm install"
    )
    start "ProTrade Backend" cmd /k "cd /d %SERVER_KLASOR% && npm start"
) else (
    echo [BILGI] Backend klasoru bulunamadi. Sadece frontend baslatiliyor.
)

:: Kisa bir bekleme
timeout /t 3 /nobreak >nul

:: 2. FRONTEND KONTROL VE BASLATMA
echo [2/4] Frontend (Arayuz) Kontrol Ediliyor...
if not exist "%ANA_KLASOR%\node_modules" (
    echo [UYARI] Arayuz kutuphaneleri eksik! Ilk kurulum yapiliyor...
    echo Lutfen bekleyin, bu islem biraz zaman alabilir.
    cmd /c "cd /d %ANA_KLASOR% && npm install"
)
start "ProTrade Terminal" cmd /k "cd /d %ANA_KLASOR% && npm run dev"

:: 3. TARAYICI ACILIYOR (Chrome App Mode)
echo [3/4] Chrome App Mode Baslatiliyor...
echo      (Arka plan'da kesintisiz calisma icin optimize edildi)
timeout /t 6 /nobreak >nul

:: Chrome'u bul ve App Mode ile ac
where chrome >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    start "" chrome %CHROME_FLAGS%
) else (
    :: Chrome PATH'te degilse varsayilan yolu dene
    if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
        start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" %CHROME_FLAGS%
    ) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
        start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" %CHROME_FLAGS%
    ) else (
        echo [UYARI] Chrome bulunamadi! Normal tarayici aciliyor...
        start %URL%
    )
)

echo.
echo [4/4] ISLEM TAMAMLANDI!
echo ========================================================
echo    CHROME APP MODE OZELLIKLERI:
echo    - Ayri pencerede calisir (sekme degil)
echo    - Arka planda tam guc calisir
echo    - Minimize edilse bile sinyal uretir
echo    - WebSocket baglantisi kesilmez
echo ========================================================
echo.
echo Terminal pencerelerini simge durumuna kucultebilirsiniz.
echo KAPATMAYIN - Arka planda calismaya devam edecektir.
echo.
timeout /t 5
exit