// Configuration State
const config = {
    global: {
        domains: ['example.com'], // Support multiple domains
        onmicrosoftDomain: 'example.onmicrosoft.com',
        adminEmail: 'admin@example.com',
        igeeksEmail: 'alerts.normal@igeeks.ch'
    },
    antiPhishing: {
        spoofIntelligence: true,
        firstContactTip: true,
        unauthSenderSymbol: true,
        viaTag: true,
        honorDmarc: true,
        dmarcQuarantineAction: 'Quarantine',
        dmarcRejectAction: 'Reject',
        spoofAction: 'MoveToJmf'
    },
    antiSpam: {
        bulkThreshold: 7,
        bizInfoUrls: true,
        numericIpUrls: true,
        urlRedirect: true,
        emptyMessages: true,
        jsVbScript: true,
        frameIframe: true,
        sensitiveWords: true,
        spfHardFail: true,
        backscatter: true,
        spamAction: 'MoveToJmf',
        highConfSpamAction: 'MoveToJmf',
        bulkAction: 'MoveToJmf',
        phishAction: 'Quarantine',
        highConfPhishAction: 'Quarantine'
    },
    antiMalware: {
        commonAttachFilter: true,
        zapMalware: true,
        customFileTypes: '.ace, .apk, .app, .appx, .arj, .bat, .cab, .cmd, .com, .deb, .dex, .dll, .dmg, .elf, .exe, .hta, .img, .iso, .jar, .jnlp, .kext, .lha, .lib, .library, .lnk, .lzh, .macho, .msc, .msi, .msix, .msp, .mst, .pif, .pkg, .prf, .ps1, .scr, .sct, .sys, .vb, .vbe, .vbs, .vxd, .wsc, .wsf, .wsh, .xll',
        malwareAction: 'Reject'
    }
};

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    initializeTabs();
    initializeToggles();
    initializeDomains(); // Initialize domain management
    initializeInputs();
    initializePresets();
    initializeImportExport();
    initializeExport();
    loadDocumentation();
    loadRecommendations();
});

// Preset Templates
const presets = {
    igeeks: {
        global: {
            domains: ['hotel-krone.ch'],
            onmicrosoftDomain: 'kroneunterstrass.onmicrosoft.com',
            adminEmail: 'alerts.normal@igeeks.ch',
            igeeksEmail: 'alerts.normal@igeeks.ch'
        },
        antiPhishing: {
            spoofIntelligence: true,
            firstContactTip: true,
            unauthSenderSymbol: true,
            viaTag: true,
            honorDmarc: true,
            dmarcQuarantineAction: 'Quarantine',
            dmarcRejectAction: 'Reject',
            spoofAction: 'MoveToJmf'
        },
        antiSpam: {
            bulkThreshold: 7,
            bizInfoUrls: true,
            numericIpUrls: true,
            urlRedirect: true,
            emptyMessages: true,
            jsVbScript: true,
            frameIframe: true,
            sensitiveWords: true,
            spfHardFail: true,
            backscatter: true,
            spamAction: 'MoveToJmf',
            highConfSpamAction: 'MoveToJmf',
            bulkAction: 'MoveToJmf',
            phishAction: 'Quarantine',
            highConfPhishAction: 'Quarantine'
        },
        antiMalware: {
            commonAttachFilter: true,
            zapMalware: true,
            customFileTypes: '.ace, .apk, .app, .appx, .ani, .arj, .bat, .cab, .cmd, .com, .deb, .dex, .dll, .dmg, .elf, .exe, .hta, .img, .iso, .jar, .jnlp, .kext, .lha, .lib, .library, .lnk, .lzh, .macho, .msc, .msi, .msix, .msp, .mst, .pif, .pkg, .prf, .ps1, .scr, .sct, .sys, .vb, .vbe, .vbs, .vxd, .wsc, .wsf, .wsh, .xll',
            malwareAction: 'Reject'
        }
    },
    balanced: {
        antiPhishing: {
            spoofIntelligence: true,
            firstContactTip: true,
            unauthSenderSymbol: true,
            viaTag: true,
            honorDmarc: true,
            dmarcQuarantineAction: 'Quarantine',
            dmarcRejectAction: 'Reject',
            spoofAction: 'MoveToJmf'
        },
        antiSpam: {
            bulkThreshold: 7,
            bizInfoUrls: true,
            numericIpUrls: true,
            urlRedirect: true,
            emptyMessages: true,
            jsVbScript: true,
            frameIframe: true,
            sensitiveWords: true,
            spfHardFail: true,
            backscatter: true,
            spamAction: 'MoveToJmf',
            highConfSpamAction: 'MoveToJmf',
            bulkAction: 'MoveToJmf',
            phishAction: 'Quarantine',
            highConfPhishAction: 'Quarantine'
        },
        antiMalware: {
            commonAttachFilter: true,
            zapMalware: true,
            customFileTypes: '.ace, .apk, .app, .appx, .arj, .bat, .cab, .cmd, .com, .deb, .dex, .dll, .dmg, .elf, .exe, .hta, .img, .iso, .jar, .jnlp, .kext, .lha, .lib, .library, .lnk, .lzh, .macho, .msc, .msi, .msix, .msp, .mst, .pif, .pkg, .prf, .ps1, .scr, .sct, .sys, .vb, .vbe, .vbs, .vxd, .wsc, .wsf, .wsh, .xll',
            malwareAction: 'Reject'
        }
    },
    strict: {
        antiPhishing: {
            spoofIntelligence: true,
            firstContactTip: true,
            unauthSenderSymbol: true,
            viaTag: true,
            honorDmarc: true,
            dmarcQuarantineAction: 'Quarantine',
            dmarcRejectAction: 'Reject',
            spoofAction: 'Quarantine'
        },
        antiSpam: {
            bulkThreshold: 5,
            bizInfoUrls: true,
            numericIpUrls: true,
            urlRedirect: true,
            emptyMessages: true,
            jsVbScript: true,
            frameIframe: true,
            sensitiveWords: true,
            spfHardFail: true,
            backscatter: true,
            spamAction: 'Quarantine',
            highConfSpamAction: 'Quarantine',
            bulkAction: 'Quarantine',
            phishAction: 'Quarantine',
            highConfPhishAction: 'Quarantine'
        },
        antiMalware: {
            commonAttachFilter: true,
            zapMalware: true,
            customFileTypes: '.ace, .apk, .app, .appx, .arj, .bat, .cab, .cmd, .com, .deb, .dex, .dll, .dmg, .docm, .elf, .exe, .hta, .img, .iso, .jar, .jnlp, .kext, .lha, .lib, .library, .lnk, .lzh, .macho, .msc, .msi, .msix, .msp, .mst, .pif, .pkg, .pptm, .prf, .ps1, .scr, .sct, .sys, .vb, .vbe, .vbs, .vxd, .wsc, .wsf, .wsh, .xll, .xlsm',
            malwareAction: 'Reject'
        }
    },
    relaxed: {
        antiPhishing: {
            spoofIntelligence: true,
            firstContactTip: true,
            unauthSenderSymbol: true,
            viaTag: false,
            honorDmarc: true,
            dmarcQuarantineAction: 'MoveToJmf',
            dmarcRejectAction: 'Quarantine',
            spoofAction: 'MoveToJmf'
        },
        antiSpam: {
            bulkThreshold: 8,
            bizInfoUrls: false,
            numericIpUrls: true,
            urlRedirect: false,
            emptyMessages: false,
            jsVbScript: true,
            frameIframe: false,
            sensitiveWords: false,
            spfHardFail: true,
            backscatter: true,
            spamAction: 'MoveToJmf',
            highConfSpamAction: 'MoveToJmf',
            bulkAction: 'MoveToJmf',
            phishAction: 'MoveToJmf',
            highConfPhishAction: 'Quarantine'
        },
        antiMalware: {
            commonAttachFilter: true,
            zapMalware: true,
            customFileTypes: '.ace, .apk, .app, .exe, .bat, .cmd, .com, .dll, .jar, .msi, .ps1, .scr, .vbs, .vbe',
            malwareAction: 'Reject'
        }
    }
};

// Tab Navigation
function initializeTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.dataset.tab;

            // Remove active class from all
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            // Add active class to clicked
            btn.classList.add('active');
            document.getElementById(targetTab).classList.add('active');
        });
    });
}

// Policy Card Toggles
function initializeToggles() {
    const toggleBtns = document.querySelectorAll('.toggle-btn');

    toggleBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetId = btn.dataset.target;
            const details = document.getElementById(targetId);
            const card = btn.closest('.policy-card');

            details.classList.toggle('active');
            card.classList.toggle('expanded');
        });
    });

    // Also toggle on header click
    document.querySelectorAll('.policy-header').forEach(header => {
        header.addEventListener('click', () => {
            const toggleBtn = header.querySelector('.toggle-btn');
            if (toggleBtn) toggleBtn.click();
        });
    });
}

// Input Synchronization
function initializeInputs() {
    // Global settings - onmicrosoftDomain
    document.getElementById('onmicrosoftDomain').addEventListener('input', (e) => {
        config.global.onmicrosoftDomain = e.target.value;
    });

    document.getElementById('adminEmail').addEventListener('input', (e) => {
        config.global.adminEmail = e.target.value;
        // Update Alert Policy display
        const displayElem = document.getElementById('displayAdminEmail');
        if (displayElem) displayElem.textContent = e.target.value;
    });

    document.getElementById('igeeksEmail').addEventListener('input', (e) => {
        config.global.igeeksEmail = e.target.value;
        // Update Alert Policy display
        const displayElem = document.getElementById('displayIgeeksEmail');
        if (displayElem) displayElem.textContent = e.target.value;
    });

    // Policy settings
    document.querySelectorAll('[data-setting]').forEach(input => {
        input.addEventListener('change', (e) => {
            const setting = e.target.dataset.setting;
            const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;

            // Update config based on input location
            if (setting.includes('spoof') || setting.includes('dmarc') || setting.includes('honor') || setting.includes('via') || setting.includes('unauth') || setting.includes('first')) {
                config.antiPhishing[setting] = value;
            } else if (setting.includes('spam') || setting.includes('bulk') || setting.includes('phish') || setting.includes('biz') || setting.includes('numeric') || setting.includes('redirect') || setting.includes('empty') || setting.includes('js') || setting.includes('frame') || setting.includes('sensitive') || setting.includes('spf') || setting.includes('backscatter')) {
                config.antiSpam[setting] = value;
            } else if (setting.includes('malware') || setting.includes('zap') || setting.includes('attach') || setting.includes('customFile')) {
                config.antiMalware[setting] = value;
            }
        });
    });
}

// Preset Templates
function initializePresets() {
    const presetSelector = document.getElementById('presetSelector');

    presetSelector.addEventListener('change', (e) => {
        const presetName = e.target.value;
        if (!presetName) return;

        const preset = presets[presetName];
        if (!preset) return;

        // Apply preset to config - handle global settings
        if (preset.global) {
            config.global.domains = [...preset.global.domains];
            config.global.onmicrosoftDomain = preset.global.onmicrosoftDomain;
            config.global.adminEmail = preset.global.adminEmail;
            config.global.igeeksEmail = preset.global.igeeksEmail;
        }

        Object.assign(config.antiPhishing, preset.antiPhishing);
        Object.assign(config.antiSpam, preset.antiSpam);
        Object.assign(config.antiMalware, preset.antiMalware);

        // Update UI
        renderDomains(); // Update domain list
        updateUIFromConfig();

        // Reset selector
        setTimeout(() => {
            presetSelector.value = '';
        }, 100);
    });
}

// Update UI from config
function updateUIFromConfig() {
    // Update all checkboxes and selects
    document.querySelectorAll('[data-setting]').forEach(input => {
        const setting = input.dataset.setting;
        let value;

        if (setting in config.antiPhishing) {
            value = config.antiPhishing[setting];
        } else if (setting in config.antiSpam) {
            value = config.antiSpam[setting];
        } else if (setting in config.antiMalware) {
            value = config.antiMalware[setting];
        }

        if (input.type === 'checkbox') {
            input.checked = value;
        } else {
            input.value = value;
        }
    });
}

// Import/Export JSON
function initializeImportExport() {
    const importBtn = document.getElementById('importBtn');

    importBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const imported = JSON.parse(event.target.result);

                    // Merge imported config
                    if (imported.global) Object.assign(config.global, imported.global);
                    if (imported.antiPhishing) Object.assign(config.antiPhishing, imported.antiPhishing);
                    if (imported.antiSpam) Object.assign(config.antiSpam, imported.antiSpam);
                    if (imported.antiMalware) Object.assign(config.antiMalware, imported.antiMalware);

                    // Update UI
                    document.getElementById('primaryDomain').value = config.global.primaryDomain;
                    document.getElementById('onmicrosoftDomain').value = config.global.onmicrosoftDomain;
                    document.getElementById('adminEmail').value = config.global.adminEmail;
                    updateUIFromConfig();

                    alert('✅ Konfiguration erfolgreich importiert!');
                } catch (error) {
                    alert('❌ Fehler beim Importieren: ' + error.message);
                }
            };
            reader.readAsText(file);
        });

        input.click();
    });
}

// Export Functionality
function initializeExport() {
    const exportBtn = document.getElementById('exportBtn');
    const modal = document.getElementById('exportModal');
    const closeBtn = modal.querySelector('.close-btn');
    const copyBtn = document.getElementById('copyBtn');
    const downloadBtn = document.getElementById('downloadBtn');

    exportBtn.addEventListener('click', () => {
        generateExportPreview();
        modal.style.display = 'flex';
    });

    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });

    copyBtn.addEventListener('click', () => {
        const preview = document.getElementById('exportPreview').textContent;
        navigator.clipboard.writeText(preview).then(() => {
            copyBtn.textContent = '✓ Copied!';
            setTimeout(() => {
                copyBtn.innerHTML = 'Copy to Clipboard';
            }, 2000);
        });
    });

    downloadBtn.addEventListener('click', () => {
        const preview = document.getElementById('exportPreview').textContent;
        const blob = new Blob([preview], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'M365-BestPractice-Deployment.ps1';
        a.click();
        URL.revokeObjectURL(url);
    });

    // JSON Export
    document.getElementById('exportJsonBtn').addEventListener('click', () => {
        const configJson = JSON.stringify(config, null, 2);
        const blob = new Blob([configJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'm365-config.json';
        a.click();
        URL.revokeObjectURL(url);
    });

    // Documentation Export (Markdown)
    const exportDocsBtn = document.getElementById('exportDocsBtn');
    if (exportDocsBtn) {
        exportDocsBtn.addEventListener('click', () => {
            const markdown = generateMarkdownDocumentation();
            const blob = new Blob([markdown], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'M365-Security-Configuration.md';
            a.click();
            URL.revokeObjectURL(url);
        });
    }
}

// Generate PowerShell Export
function generateExportPreview() {
    const includeDeployment = document.getElementById('includeDeployment').checked;
    const includeVerification = document.getElementById('includeVerification').checked;
    const includeDocumentation = document.getElementById('includeDocumentation').checked;

    let script = '';

    if (includeDocumentation) {
        script += generateDocumentationHeader();
    }

    if (includeDeployment) {
        script += generateDeploymentScript();
    }

    if (includeVerification) {
        script += generateVerificationScript();
    }

    document.getElementById('exportPreview').textContent = script;
}

function generateDocumentationHeader() {
    return `<#
.SYNOPSIS
    igeeks Best Practice M365 Security Policy Deployment

.DESCRIPTION
    Dieses Script implementiert die igeeks Best-Practice Konfiguration für:
    - Anti-Phishing Policy
    - Anti-Spam Inbound Policy
    - Anti-Malware Policy
    - Quarantine Policies

.NOTES
    Domains: ${config.global.domains.join(', ')}, ${config.global.onmicrosoftDomain}
    Admin Email: ${config.global.adminEmail}
    Generated: ${new Date().toISOString()}
    
.LINK
    https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/
#>

`;
}

// Helper function to generate domain list for PowerShell
function generateDomainList() {
    const allDomains = [...config.global.domains, config.global.onmicrosoftDomain];
    return allDomains.map(d => `"${d}"`).join(',');
}

function generateDeploymentScript() {
    const fileTypesArray = config.antiMalware.customFileTypes.split(',').map(t => `'${t.trim()}'`).join(', ');
    const domainList = generateDomainList();

    return `# ============================================
# DEPLOYMENT SCRIPT
# ============================================

# Connect to Exchange Online
Write-Host "Connecting to Exchange Online..." -ForegroundColor Cyan
Connect-ExchangeOnline

# ⚠️ IMPORTANT: Alert Policy requires Security & Compliance PowerShell
Write-Host "Connecting to Security & Compliance PowerShell..." -ForegroundColor Cyan
Connect-IPPSSession

# ============================================
# 1. QUARANTINE POLICIES
# ============================================
Write-Host "Creating Quarantine Policies..." -ForegroundColor Yellow

# Self-Release Notification Policy
try {
    $qp1 = Get-QuarantinePolicy -Identity "BP_Quarantine-SelfReleaseNotification" -ErrorAction SilentlyContinue
    if ($null -eq $qp1) {
        New-QuarantinePolicy -Name "BP_Quarantine-SelfReleaseNotification" \`
            -EndUserQuarantinePermissionsValue 236 \`
            -ESNEnabled $true
        Write-Host "✓ Created BP_Quarantine-SelfReleaseNotification" -ForegroundColor Green
    } else {
        Write-Host "⚠ BP_Quarantine-SelfReleaseNotification already exists, skipping" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Error creating BP_Quarantine-SelfReleaseNotification: $_" -ForegroundColor Red
}

# Request-Release Notification Policy
try {
    $qp2 = Get-QuarantinePolicy -Identity "BP_Quarantine-RequestReleaseNotification" -ErrorAction SilentlyContinue
    if ($null -eq $qp2) {
        New-QuarantinePolicy -Name "BP_Quarantine-RequestReleaseNotification" \`
            -EndUserQuarantinePermissionsValue 171 \`
            -ESNEnabled $true
        Write-Host "✓ Created BP_Quarantine-RequestReleaseNotification" -ForegroundColor Green
    } else {
        Write-Host "⚠ BP_Quarantine-RequestReleaseNotification already exists, skipping" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Error creating BP_Quarantine-RequestReleaseNotification: $_" -ForegroundColor Red
}

# ============================================
# 2. ANTI-PHISHING POLICY
# ============================================
Write-Host "Configuring Anti-Phishing Policy..." -ForegroundColor Yellow

# Create or Update Anti-Phishing Policy
try {
    $ap = Get-AntiPhishPolicy -Identity "BP_AntiPhishing" -ErrorAction SilentlyContinue
    if ($null -eq $ap) {
        New-AntiPhishPolicy -Name "BP_AntiPhishing" \`
            -Enabled $true \`
            -EnableSpoofIntelligence $${config.antiPhishing.spoofIntelligence} \`
            -EnableFirstContactSafetyTips $${config.antiPhishing.firstContactTip} \`
            -EnableUnauthenticatedSender $${config.antiPhishing.unauthSenderSymbol} \`
            -EnableViaTag $${config.antiPhishing.viaTag} \`
            -HonorDmarcPolicy $${config.antiPhishing.honorDmarc} \`
            -DmarcQuarantineAction ${config.antiPhishing.dmarcQuarantineAction} \`
            -DmarcRejectAction ${config.antiPhishing.dmarcRejectAction} \`
            -AuthenticationFailAction ${config.antiPhishing.spoofAction}
        Write-Host "✓ Created BP_AntiPhishing policy" -ForegroundColor Green
    } else {
        Set-AntiPhishPolicy -Identity "BP_AntiPhishing" \`
            -Enabled $true \`
            -EnableSpoofIntelligence $${config.antiPhishing.spoofIntelligence} \`
            -EnableFirstContactSafetyTips $${config.antiPhishing.firstContactTip} \`
            -EnableUnauthenticatedSender $${config.antiPhishing.unauthSenderSymbol} \`
            -EnableViaTag $${config.antiPhishing.viaTag} \`
            -HonorDmarcPolicy $${config.antiPhishing.honorDmarc} \`
            -DmarcQuarantineAction ${config.antiPhishing.dmarcQuarantineAction} \`
            -DmarcRejectAction ${config.antiPhishing.dmarcRejectAction} \`
            -AuthenticationFailAction ${config.antiPhishing.spoofAction}
        Write-Host "✓ Updated BP_AntiPhishing policy" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error with BP_AntiPhishing policy: $_" -ForegroundColor Red
}

# Create Anti-Phishing Rule
try {
    $apr = Get-AntiPhishRule -Identity "BP_AntiPhishing_Rule" -ErrorAction SilentlyContinue
    if ($null -eq $apr) {
        New-AntiPhishRule -Name "BP_AntiPhishing_Rule" \`
            -AntiPhishPolicy "BP_AntiPhishing" \`
            -RecipientDomainIs ${domainList} \`
            -Priority 0
        Write-Host "✓ Created BP_AntiPhishing_Rule" -ForegroundColor Green
    } else {
        Write-Host "⚠ BP_AntiPhishing_Rule already exists, skipping" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Error creating BP_AntiPhishing_Rule: $_" -ForegroundColor Red
}

# ⚠️ CRITICAL: Set Quarantine Policy via PowerShell (GUI limitation workaround)
Write-Host "Setting Spoof Quarantine Tag (GUI workaround)..." -ForegroundColor Cyan
try {
    Set-AntiPhishPolicy -Identity "BP_AntiPhishing" \`
        -SpoofQuarantineTag "BP_Quarantine-SelfReleaseNotification"
    Write-Host "✓ Set SpoofQuarantineTag to BP_Quarantine-SelfReleaseNotification" -ForegroundColor Green
} catch {
    Write-Host "❌ Error setting SpoofQuarantineTag: $_" -ForegroundColor Red
}

# ============================================
# 3. ANTI-SPAM POLICY
# ============================================
Write-Host "Configuring Anti-Spam Policy..." -ForegroundColor Yellow

# Create or Update Anti-Spam Policy
try {
    $asp = Get-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" -ErrorAction SilentlyContinue
    if ($null -eq $asp) {
        New-HostedContentFilterPolicy -Name "BP_AntiSpam_Inbound" \`
            -BulkThreshold ${config.antiSpam.bulkThreshold} \`
            -EnableEndUserSpamNotifications $true \`
            -EndUserSpamNotificationFrequency 1 \`
            -SpamAction ${config.antiSpam.spamAction} \`
            -HighConfidenceSpamAction ${config.antiSpam.highConfSpamAction} \`
            -BulkSpamAction ${config.antiSpam.bulkAction} \`
            -PhishSpamAction ${config.antiSpam.phishAction} \`
            -HighConfidencePhishAction ${config.antiSpam.highConfPhishAction} \`
            -QuarantineRetentionPeriod 30 \`
            -InlineSafetyTipsEnabled $true \`
            -PhishQuarantineTag "BP_Quarantine-SelfReleaseNotification" \`
            -HighConfidencePhishQuarantineTag "BP_Quarantine-RequestReleaseNotification"
        Write-Host "✓ Created BP_AntiSpam_Inbound policy" -ForegroundColor Green
    } else {
        Set-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" \`
            -BulkThreshold ${config.antiSpam.bulkThreshold} \`
            -EnableEndUserSpamNotifications $true \`
            -EndUserSpamNotificationFrequency 1 \`
            -SpamAction ${config.antiSpam.spamAction} \`
            -HighConfidenceSpamAction ${config.antiSpam.highConfSpamAction} \`
            -BulkSpamAction ${config.antiSpam.bulkAction} \`
            -PhishSpamAction ${config.antiSpam.phishAction} \`
            -HighConfidencePhishAction ${config.antiSpam.highConfPhishAction} \`
            -QuarantineRetentionPeriod 30 \`
            -InlineSafetyTipsEnabled $true \`
            -PhishQuarantineTag "BP_Quarantine-SelfReleaseNotification" \`
            -HighConfidencePhishQuarantineTag "BP_Quarantine-RequestReleaseNotification"
        Write-Host "✓ Updated BP_AntiSpam_Inbound policy" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error with BP_AntiSpam_Inbound policy: $_" -ForegroundColor Red
}

# Advanced Spam Filters
try {
    Set-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" \`
        -IncreaseScoreWithBizOrInfoUrls $(if ($${config.antiSpam.bizInfoUrls}) {'On'} else {'Off'}) \`
        -IncreaseScoreWithNumericIps $(if ($${config.antiSpam.numericIpUrls}) {'On'} else {'Off'}) \`
        -IncreaseScoreWithRedirectToOtherPort $(if ($${config.antiSpam.urlRedirect}) {'On'} else {'Off'}) \`
        -MarkAsSpamEmptyMessages $(if ($${config.antiSpam.emptyMessages}) {'On'} else {'Off'}) \`
        -MarkAsSpamJavaScriptInHtml $(if ($${config.antiSpam.jsVbScript}) {'On'} else {'Off'}) \`
        -MarkAsSpamFramesInHtml $(if ($${config.antiSpam.frameIframe}) {'On'} else {'Off'}) \`
        -MarkAsSpamSensitiveWordList $(if ($${config.antiSpam.sensitiveWords}) {'On'} else {'Off'}) \`
        -MarkAsSpamSpfRecordHardFail $(if ($${config.antiSpam.spfHardFail}) {'On'} else {'Off'}) \`
        -MarkAsSpamFromAddressAuthFail $(if ($${config.antiSpam.backscatter}) {'On'} else {'Off'})
    Write-Host "✓ Configured advanced spam filters" -ForegroundColor Green
} catch {
    Write-Host "❌ Error setting advanced spam filters: $_" -ForegroundColor Red
}

# Create Anti-Spam Rule
try {
    $asr = Get-HostedContentFilterRule -Identity "BP_AntiSpam_Inbound_Rule" -ErrorAction SilentlyContinue
    if ($null -eq $asr) {
        New-HostedContentFilterRule -Name "BP_AntiSpam_Inbound_Rule" \`
            -HostedContentFilterPolicy "BP_AntiSpam_Inbound" \`
            -RecipientDomainIs ${domainList} \`
            -Priority 0
        Write-Host "✓ Created BP_AntiSpam_Inbound_Rule" -ForegroundColor Green
    } else {
        Write-Host "⚠ BP_AntiSpam_Inbound_Rule already exists, skipping" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Error creating BP_AntiSpam_Inbound_Rule: $_" -ForegroundColor Red
}

# ============================================
# 4. ANTI-MALWARE POLICY
# ============================================
Write-Host "Configuring Anti-Malware Policy..." -ForegroundColor Yellow

$fileTypes = @(${fileTypesArray})

# Create or Update Anti-Malware Policy
try {
    $amp = Get-MalwareFilterPolicy -Identity "BP_AntiMalware" -ErrorAction SilentlyContinue
    if ($null -eq $amp) {
        New-MalwareFilterPolicy -Name "BP_AntiMalware" \`
            -EnableFileFilter $${config.antiMalware.commonAttachFilter} \`
            -FileTypes $fileTypes \`
            -EnableInternalSenderAdminNotifications $true \`
            -EnableExternalSenderAdminNotifications $true \`
            -InternalSenderAdminAddress "${config.global.adminEmail}" \`
            -ExternalSenderAdminAddress "${config.global.adminEmail}" \`
            -ZapEnabled $${config.antiMalware.zapMalware} \`
            -QuarantineTag "BP_Quarantine-RequestReleaseNotification"
        Write-Host "✓ Created BP_AntiMalware policy" -ForegroundColor Green
    } else {
        Set-MalwareFilterPolicy -Identity "BP_AntiMalware" \`
            -EnableFileFilter $${config.antiMalware.commonAttachFilter} \`
            -FileTypes $fileTypes \`
            -EnableInternalSenderAdminNotifications $true \`
            -EnableExternalSenderAdminNotifications $true \`
            -InternalSenderAdminAddress "${config.global.adminEmail}" \`
            -ExternalSenderAdminAddress "${config.global.adminEmail}" \`
            -ZapEnabled $${config.antiMalware.zapMalware} \`
            -QuarantineTag "BP_Quarantine-RequestReleaseNotification"
        Write-Host "✓ Updated BP_AntiMalware policy" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error with BP_AntiMalware policy: $_" -ForegroundColor Red
}

# Create Anti-Malware Rule
try {
    $amr = Get-MalwareFilterRule -Identity "BP_AntiMalware_Rule" -ErrorAction SilentlyContinue
    if ($null -eq $amr) {
        New-MalwareFilterRule -Name "BP_AntiMalware_Rule" \`
            -MalwareFilterPolicy "BP_AntiMalware" \`
            -RecipientDomainIs ${domainList} \`
            -Priority 0
        Write-Host "✓ Created BP_AntiMalware_Rule" -ForegroundColor Green
    } else {
        Write-Host "⚠ BP_AntiMalware_Rule already exists, skipping" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Error creating BP_AntiMalware_Rule: $_" -ForegroundColor Red
}

# ============================================
# 5. ALERT POLICY FOR QUARANTINE REQUESTS
# ============================================
Write-Host "Configuring Alert Policy for Quarantine Requests..." -ForegroundColor Yellow

# Note: Microsoft's default "User requested to release a quarantined message" policy is read-only
# We create a custom policy with igeeks email notifications
try {
    $alert = Get-ProtectionAlert -Identity "BP_UserRequestReleaseStatus" -ErrorAction SilentlyContinue
    if ($null -eq $alert) {
        # Create new custom policy
        New-ProtectionAlert \`
            -Name "BP_UserRequestReleaseStatus" \`
            -Category ThreatManagement \`
            -ThreatType Activity \`
            -Operation QuarantineRequestReleaseMessage \`
            -NotifyUser "${config.global.adminEmail}","${config.global.igeeksEmail}" \`
            -Severity Low \`
            -Description "igeeks Best Practice: User requested to release a quarantined message" \`
            -AggregationType None
        Write-Host "✓ Created BP_UserRequestReleaseStatus alert policy" -ForegroundColor Green
    } else {
        # Update existing custom policy
        Set-ProtectionAlert -Identity "BP_UserRequestReleaseStatus" \`
            -NotifyUser "${config.global.adminEmail}","${config.global.igeeksEmail}"
        Write-Host "✓ Updated BP_UserRequestReleaseStatus alert policy" -ForegroundColor Green
    }
} catch {
    Write-Host "❌ Error with quarantine alert policy: $_" -ForegroundColor Red
    Write-Host "⚠️  Note: Alert policies may require Office 365 E5 or Defender for Office 365 P2" -ForegroundColor Yellow
}

Write-Host "\\nDeployment completed!" -ForegroundColor Green
Write-Host "Please review the output above for any errors." -ForegroundColor Cyan

`;
}

function generateVerificationScript() {
    return `
# ============================================
# VERIFICATION SCRIPT
# ============================================

Write-Host "\\n=== VERIFICATION ===" -ForegroundColor Cyan

# Verify Quarantine Policies
Write-Host "\\nQuarantine Policies:" -ForegroundColor Yellow
Get-QuarantinePolicy | Where-Object {$_.Name -like "BP_*"} | Format-Table Name, ESNEnabled

# Verify Anti-Phishing
Write-Host "\\nAnti-Phishing Policy:" -ForegroundColor Yellow
Get-AntiPhishPolicy -Identity "BP_AntiPhishing" | Format-List Name, Enabled, HonorDmarcPolicy, SpoofQuarantineTag

# Verify Anti-Spam
Write-Host "\\nAnti-Spam Policy:" -ForegroundColor Yellow
Get-HostedContentFilterPolicy -Identity "BP_AntiSpam_Inbound" | Format-List Name, BulkThreshold, PhishQuarantineTag, HighConfidencePhishQuarantineTag

# Verify Anti-Malware
Write-Host "\\nAnti-Malware Policy:" -ForegroundColor Yellow
Get-MalwareFilterPolicy -Identity "BP_AntiMalware" | Format-List Name, EnableFileFilter, ZapEnabled, QuarantineTag

# Verify Alert Policy
Write-Host "\\nAlert Policy:" -ForegroundColor Yellow
Get-ProtectionAlert -Identity "BP_UserRequestReleaseStatus" -ErrorAction SilentlyContinue | Format-List Name, Operation, NotifyUser, Severity

Write-Host "\\nVerification completed!" -ForegroundColor Green
`;
}

// Load Documentation
function loadDocumentation() {
    const docsContent = document.getElementById('docsContent');
    docsContent.innerHTML = `
        <h3>🎯 Zielsetzung</h3>
        <p>Die igeeks Best-Practice Anti-Threat Konfiguration verfolgt folgende Ziele:</p>
        <ul>
            <li>Schutz vor Spoofing, Phishing und Malware</li>
            <li>Transparente Benutzerführung (Safety Tips + Quarantäne-Dialoge)</li>
            <li>Kontrollierte Freigabeprozesse</li>
            <li>Minimierung von False Positives</li>
            <li>Nachvollziehbare Admin-Benachrichtigung</li>
        </ul>

        <h3>🔐 Warum eigene Quarantäne-Policies zwingend sind</h3>
        <div class="alert alert-warning">
            <strong>⚠️ Microsoft Default Verhalten:</strong>
            <ul>
                <li>Unklare Userrechte und inkonsistente Freigabelogik</li>
                <li>Keine granular steuerbare Benachrichtigungen</li>
                <li>Keine definierte Release-Governance</li>
                <li>Intransparente User Experience</li>
            </ul>
        </div>

        <p><strong>igeeks Lösung:</strong> Zwei differenzierte Quarantine Policies:</p>
        <ul>
            <li><code>BP_Quarantine-SelfReleaseNotification</code> - Für normale Phishing-Fälle mit Benutzerautonomie</li>
            <li><code>BP_Quarantine-RequestReleaseNotification</code> - Für High Confidence Phishing mit Admin-Kontrolle</li>
        </ul>

        <h3>📧 Alert Policy für Managed Services</h3>
        <div class="alert alert-info">
            <strong>ℹ️ Wichtig für Managed Service Provider:</strong>
            Die Alert Policy <code>BP_UserRequestReleaseStatus</code> benachrichtigt igeeks automatisch, 
            wenn User eine Freigabe von quarantinierten Nachrichten anfordern.
        </div>
        <p><strong>Warum ist das kritisch?</strong></p>
        <ul>
            <li>Bei <code>BP_Quarantine-RequestReleaseNotification</code> können User Nachrichten NICHT selbst freigeben</li>
            <li>Sie können nur eine Freigabe-Anfrage stellen ("Request Release")</li>
            <li>Ohne Alert Policy würde igeeks diese Anfragen nicht mitbekommen</li>
            <li>Besonders wichtig für High Confidence Phishing und Malware</li>
        </ul>
        <p><strong>Empfänger:</strong></p>
        <ul>
            <li>Tenant Admin Email (konfigurierbar)</li>
            <li>igeeks Alert Email (konfigurierbar, Standard: <code>alerts.normal@igeeks.ch</code>)</li>
        </ul>
        <p><strong>Technische Details:</strong></p>
        <ul>
            <li><strong>Cmdlet:</strong> <code>New-ActivityAlert</code> (nicht New-ProtectionAlert!)</li>
            <li><strong>Operation:</strong> <code>QuarantineRequestReleaseMessage</code></li>
            <li><strong>Lizenz:</strong> Funktioniert mit EOP (alle M365 Lizenzen)</li>
            <li><strong>Severity:</strong> Low (informative Benachrichtigung)</li>
        </ul>

        <h3>⚠️ GUI Limitation: PowerShell Workaround</h3>
        <p>Microsoft implementiert in der GUI <strong>keine Auswahl der Quarantäne-Policy</strong> für Anti-Phishing Spoof-Fälle.</p>
        <p><strong>Lösung:</strong> Zuweisung per PowerShell:</p>
        <pre><code>Set-AntiPhishPolicy -Identity "BP_AntiPhishing" \`
    -SpoofQuarantineTag "BP_Quarantine-SelfReleaseNotification"</code></pre>

        <h3>📊 Aktionen-Differenzierung</h3>
        <table class="comparison-table">
            <thead>
                <tr>
                    <th>Kategorie</th>
                    <th>Aktion</th>
                    <th>Begründung</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Spam / Bulk</td>
                    <td>Move to Junk</td>
                    <td>Niedriges Risiko, schneller Zugriff</td>
                </tr>
                <tr>
                    <td>Phishing</td>
                    <td>Quarantine (Self-Release)</td>
                    <td>Erhöhtes Risiko, kontrollierte Freigabe</td>
                </tr>
                <tr>
                    <td>High Confidence Phishing</td>
                    <td>Quarantine (Request-Release)</td>
                    <td>Hohes Risiko, Admin-Kontrolle</td>
                </tr>
                <tr>
                    <td>Malware</td>
                    <td>Reject with NDR</td>
                    <td>Kritisches Risiko, technische Ablehnung</td>
                </tr>
            </tbody>
        </table>

        <h3>🛡️ DMARC Honor Policy</h3>
        <p>Die Konfiguration respektiert DMARC-Records der Absender-Domains:</p>
        <ul>
            <li><strong>DMARC p=reject</strong> → Nachricht wird abgelehnt</li>
            <li><strong>DMARC p=quarantine</strong> → Nachricht wird in Quarantäne verschoben</li>
            <li><strong>Spoof Intelligence</strong> → Verdächtige Nachrichten werden in Junk verschoben</li>
        </ul>
    `;
}

// Load Best Practices & Recommendations
function loadRecommendations() {
    const recommendationsContent = document.getElementById('recommendationsContent');
    recommendationsContent.innerHTML = `
        <h3>🎯 Lizenz-Überlegungen</h3>
        <div class="alert alert-info">
            <strong>ℹ️ Aktueller Scope:</strong> Diese Konfiguration basiert auf <strong>Exchange Online Protection (EOP)</strong> - enthalten in allen M365 Business/Enterprise Lizenzen.
        </div>

        <table class="comparison-table">
            <thead>
                <tr>
                    <th>Feature</th>
                    <th>EOP (Basis)</th>
                    <th>Defender for Office 365 P1</th>
                    <th>Defender for Office 365 P2</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Anti-Phishing / Anti-Spam / Anti-Malware</td>
                    <td>✅ Enthalten</td>
                    <td>✅ Erweitert</td>
                    <td>✅ Erweitert</td>
                </tr>
                <tr>
                    <td>Quarantine Policies</td>
                    <td>✅ Enthalten</td>
                    <td>✅ Enthalten</td>
                    <td>✅ Enthalten</td>
                </tr>
                <tr>
                    <td>Safe Links (URL Protection)</td>
                    <td>❌</td>
                    <td>✅</td>
                    <td>✅</td>
                </tr>
                <tr>
                    <td>Safe Attachments (Sandbox)</td>
                    <td>❌</td>
                    <td>✅</td>
                    <td>✅</td>
                </tr>
                <tr>
                    <td>Threat Investigation & Response</td>
                    <td>❌</td>
                    <td>❌</td>
                    <td>✅</td>
                </tr>
                <tr>
                    <td>Automated Investigation (AIR)</td>
                    <td>❌</td>
                    <td>❌</td>
                    <td>✅</td>
                </tr>
            </tbody>
        </table>

        <h3>🔒 Härtungs-Empfehlungen (ohne Lizenz-Upgrade)</h3>
        <ul>
            <li><strong>Strengeres Spam-Handling:</strong> High Confidence Spam von "Junk" auf "Quarantine" ändern für bessere Kontrolle</li>
            <li><strong>Tenant Allow/Block List pflegen:</strong> Regelmäßige Pflege der Allow/Block Listen im Security Portal</li>
            <li><strong>Custom File Types erweitern:</strong> Zusätzliche gefährliche Dateitypen blockieren (z.B. .docm, .xlsm, .pptm)</li>
            <li><strong>DMARC für eigene Domains:</strong> DMARC-Records mit p=quarantine oder p=reject implementieren</li>
            <li><strong>User Awareness Training:</strong> Regelmäßige Schulungen zu Phishing-Erkennung</li>
        </ul>

        <h3>📋 Operational Best Practices</h3>
        
        <h4>Monitoring & Reporting</h4>
        <ul>
            <li><strong>Quarantine Review:</strong> Tägliche Überprüfung der Quarantine für False Positives</li>
            <li><strong>Threat Dashboard:</strong> Wöchentliche Analyse im Microsoft 365 Security Center</li>
            <li><strong>Admin Notifications:</strong> Sicherstellen dass <code>${config.global.adminEmail}</code> aktiv überwacht wird</li>
            <li><strong>Message Trace:</strong> Bei Problemen Message Trace für Debugging nutzen</li>
        </ul>

        <h4>Wartung & Updates</h4>
        <ul>
            <li><strong>Quartalweise Review:</strong> Policies alle 3 Monate auf Aktualität prüfen</li>
            <li><strong>Allow/Block List Cleanup:</strong> Veraltete Einträge monatlich entfernen</li>
            <li><strong>File Type List Update:</strong> Neue Bedrohungen in Custom File Types aufnehmen</li>
            <li><strong>Microsoft Updates:</strong> Neue EOP-Features regelmäßig evaluieren</li>
        </ul>

        <h3>⚡ Quick Wins</h3>
        <div class="quick-wins-grid">
            <div class="quick-win-card">
                <h4>🎯 DMARC Enforcement</h4>
                <p>Aktiviere "Honor DMARC Policy" um Spoofing-Schutz zu maximieren</p>
                <code>✅ Bereits in Best Practice aktiviert</code>
            </div>
            <div class="quick-win-card">
                <h4>🔔 User Notifications</h4>
                <p>Aktiviere End-User Spam Notifications für Transparenz</p>
                <code>✅ Bereits in Best Practice aktiviert</code>
            </div>
            <div class="quick-win-card">
                <h4>🗑️ Zero-Hour Auto Purge</h4>
                <p>ZAP entfernt Malware automatisch aus Postfächern</p>
                <code>✅ Bereits in Best Practice aktiviert</code>
            </div>
            <div class="quick-win-card">
                <h4>⚠️ Safety Tips</h4>
                <p>Visuelle Warnungen bei verdächtigen E-Mails</p>
                <code>✅ Bereits in Best Practice aktiviert</code>
            </div>
        </div>

        <h3>🚨 Häufige Fehler vermeiden</h3>
        <div class="alert alert-warning">
            <strong>⚠️ Typische Fallstricke:</strong>
            <ul>
                <li><strong>Zu viele Allow-List Einträge:</strong> Reduziert Schutz erheblich - nur wenn absolut notwendig</li>
                <li><strong>Bulk Threshold zu hoch:</strong> Werte über 7 lassen zu viel Spam durch</li>
                <li><strong>Quarantine ohne Monitoring:</strong> Quarantine muss regelmäßig überprüft werden</li>
                <li><strong>Default Quarantine Policy:</strong> Immer eigene Policies verwenden für Kontrolle</li>
                <li><strong>Fehlende DMARC Records:</strong> Eigene Domains ohne DMARC sind anfällig für Spoofing</li>
            </ul>
        </div>

        <h3>📊 Schutzumfang-Übersicht</h3>
        <table class="comparison-table">
            <thead>
                <tr>
                    <th>Bedrohungstyp</th>
                    <th>Schutzlevel (EOP)</th>
                    <th>Empfehlung</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Known Malware</td>
                    <td>✅ Hoch</td>
                    <td>Gut abgedeckt durch Signatur-basierte Erkennung</td>
                </tr>
                <tr>
                    <td>Known Phishing</td>
                    <td>✅ Hoch</td>
                    <td>Gut abgedeckt durch Heuristik + DMARC</td>
                </tr>
                <tr>
                    <td>Spoofing / DMARC</td>
                    <td>✅ Hoch</td>
                    <td>Exzellent mit Honor DMARC Policy</td>
                </tr>
                <tr>
                    <td>Spam / Bulk</td>
                    <td>✅ Hoch</td>
                    <td>Gut konfigurierbar mit Bulk Threshold</td>
                </tr>
                <tr>
                    <td>Zero-Day URLs</td>
                    <td>⚠️ Mittel</td>
                    <td>Upgrade auf Defender P1 für Safe Links empfohlen</td>
                </tr>
                <tr>
                    <td>Zero-Day Attachments</td>
                    <td>⚠️ Mittel</td>
                    <td>Upgrade auf Defender P1 für Safe Attachments empfohlen</td>
                </tr>
                <tr>
                    <td>Advanced Persistent Threats</td>
                    <td>⚠️ Niedrig</td>
                    <td>Upgrade auf Defender P2 für AIR + Threat Hunting</td>
                </tr>
            </tbody>
        </table>

        <h3>🎓 Weiterführende Ressourcen</h3>
        <ul>
            <li><a href="https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/" target="_blank">Microsoft 365 Security Documentation</a></li>
            <li><a href="https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/recommended-settings-for-eop-and-office365" target="_blank">Microsoft Recommended Settings for EOP</a></li>
            <li><a href="https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/quarantine-policies" target="_blank">Quarantine Policies Documentation</a></li>
            <li><a href="https://docs.microsoft.com/en-us/microsoft-365/security/office-365-security/anti-spam-protection" target="_blank">Anti-Spam Protection</a></li>
        </ul>
    `;
}

// Generate Markdown Documentation
function generateMarkdownDocumentation() {
    const date = new Date().toLocaleDateString('de-DE');

    return `# Microsoft 365 Security Configuration
## igeeks Best Practice Settings

**Erstellt am:** ${date}  
**Domains:** ${config.global.domains.join(', ')}, ${config.global.onmicrosoftDomain}  
**Admin Email:** ${config.global.adminEmail}

---

## 📋 Konfigurationsübersicht

### Globale Einstellungen

| Einstellung | Wert |
|-------------|------|
| **Accepted Domains** | ${config.global.domains.join(', ')} |
| **OnMicrosoft Domain** | ${config.global.onmicrosoftDomain} |
| **Admin Email** | ${config.global.adminEmail} |
| **igeeks Email** | ${config.global.igeeksEmail} |

---

## 🛡️ Anti-Phishing Policy

| Feature | Status |
|---------|--------|
| **Spoof Intelligence** | ${config.antiPhishing.spoofIntelligence ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **First Contact Tip** | ${config.antiPhishing.firstContactTip ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **Unauthenticated Sender** | ${config.antiPhishing.unauthSenderSymbol ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **Via Tag** | ${config.antiPhishing.viaTag ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **Honor DMARC** | ${config.antiPhishing.honorDmarc ? '✅ Aktiviert' : '❌ Deaktiviert'} |

**DMARC Actions:** Quarantine=${config.antiPhishing.dmarcQuarantineAction}, Reject=${config.antiPhishing.dmarcRejectAction}

---

## 📧 Anti-Spam Policy

| Einstellung | Wert |
|-------------|------|
| **Bulk Threshold** | ${config.antiSpam.bulkThreshold} |
| **Spam Action** | ${config.antiSpam.spamAction} |
| **High Confidence Spam** | ${config.antiSpam.highConfSpamAction} |
| **Phishing Action** | ${config.antiSpam.phishAction} |
| **High Confidence Phishing** | ${config.antiSpam.highConfPhishAction} |

**Filter:** biz/info URLs=${config.antiSpam.bizInfoUrls ? '✅' : '❌'}, Numeric IPs=${config.antiSpam.numericIpUrls ? '✅' : '❌'}, JavaScript=${config.antiSpam.jsVbScript ? '✅' : '❌'}

---

## 🦠 Anti-Malware Policy

| Feature | Status |
|---------|--------|
| **Common Attachment Filter** | ${config.antiMalware.commonAttachFilter ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **ZAP** | ${config.antiMalware.zapMalware ? '✅ Aktiviert' : '❌ Deaktiviert'} |
| **Malware Action** | ${config.antiMalware.malwareAction} |

**Blockierte Dateitypen:** ${config.antiMalware.customFileTypes}

---

## 🔔 Alert Policy

**Policy:** BP_UserRequestReleaseStatus  
**Operation:** QuarantineRequestReleaseMessage  
**Benachrichtigung:** ${config.global.adminEmail}, ${config.global.igeeksEmail}

---

## 📦 Quarantine Policies

### BP_Quarantine-SelfReleaseNotification
✅ Self-Service Release | ✅ Preview | ✅ Delete

### BP_Quarantine-RequestReleaseNotification
✅ Request Release (Admin) | ✅ Preview | ✅ Delete | ❌ Direct Release

---

*Generiert mit igeeks M365 Security Policy Manager*
`;
}
