'use strict';

let currentPatientId = null;
let patientsCache = [];

document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    setupEventListeners();
    await loadStats();
    await loadPatients();
    await initAiAssistant();
}

function setupEventListeners() {
    // Search input
    const searchInput = document.getElementById('patient-search');
    searchInput.addEventListener('input', (e) => {
        filterPatients(e.target.value);
    });

    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            switchTab(targetTab);
        });
    });

    // Raw encrypted toggle
    const toggleRawBtn = document.getElementById('btn-toggle-raw-encrypted');
    toggleRawBtn.addEventListener('click', () => {
        const rawEl = document.getElementById('raw-encrypted-content');
        rawEl.classList.toggle('hidden');
        toggleRawBtn.textContent = rawEl.classList.contains('hidden')
            ? 'View Raw Encrypted LevelDB Bytes'
            : 'Hide Raw Encrypted LevelDB Bytes';
    });

    // Grant access button
    document.getElementById('btn-submit-grant').addEventListener('click', handleGrantAccess);

    // Modal triggers
    const modal = document.getElementById('create-modal');
    document.getElementById('btn-open-create-modal').addEventListener('click', () => {
        modal.classList.remove('hidden');
    });
    document.getElementById('btn-close-modal').addEventListener('click', () => {
        modal.classList.add('hidden');
    });
    document.getElementById('btn-cancel-modal').addEventListener('click', () => {
        modal.classList.add('hidden');
    });

    // Form submission
    document.getElementById('create-patient-form').addEventListener('submit', handleCreatePatient);

    // Quick Ingest Button
    document.getElementById('btn-quick-ingest').addEventListener('click', handleQuickIngest);
}

// Switch view tabs
function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active', 'hidden'));

    const activeBtn = document.querySelector(`[data-tab="${tabId}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(content => {
        if (content.id === tabId) {
            content.classList.add('active');
        } else {
            content.classList.add('hidden');
        }
    });
}

// Load stats from server
async function loadStats() {
    try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        document.getElementById('stat-total-patients').textContent = data.totalPatients;
    } catch (err) {
        console.error('Failed to load stats:', err);
    }
}

// Load patients list
async function loadPatients() {
    const listEl = document.getElementById('patient-list');
    try {
        const res = await fetch('/api/patients');
        patientsCache = await res.json();
        renderPatientList(patientsCache);

        // Auto select first patient if available
        if (patientsCache.length > 0 && !currentPatientId) {
            selectPatient(patientsCache[0].patientId);
        }
    } catch (err) {
        listEl.innerHTML = `<div class="loading-state">Error loading patients: ${err.message}</div>`;
    }
}

// Render patient list items
function renderPatientList(patients) {
    const listEl = document.getElementById('patient-list');
    if (patients.length === 0) {
        listEl.innerHTML = '<div class="loading-state">No patient records found</div>';
        return;
    }

    listEl.innerHTML = patients.map(p => `
        <div class="patient-item ${p.patientId === currentPatientId ? 'active' : ''}" data-id="${p.patientId}">
            <div class="item-top">
                <span class="item-id">${p.patientId}</span>
                <span class="item-hospital">${p.hospital}</span>
            </div>
            <div class="item-name">${p.name || 'Anonymous'}</div>
            <div class="item-sub">${p.age || '--'} yrs • ${p.gender || '--'}</div>
        </div>
    `).join('');

    // Attach click events
    listEl.querySelectorAll('.patient-item').forEach(item => {
        item.addEventListener('click', () => {
            const id = item.getAttribute('data-id');
            selectPatient(id);
        });
    });
}

// Filter patients
function filterPatients(query) {
    const q = query.toLowerCase();
    const filtered = patientsCache.filter(p =>
        p.patientId.toLowerCase().includes(q) ||
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.hospital && p.hospital.toLowerCase().includes(q))
    );
    renderPatientList(filtered);
}

// Select and load detailed patient view
async function selectPatient(patientId) {
    currentPatientId = patientId;

    // Update active highlight in list
    document.querySelectorAll('.patient-item').forEach(item => {
        item.classList.toggle('active', item.getAttribute('data-id') === patientId);
    });

    const emptyState = document.getElementById('empty-state');
    const recordDetails = document.getElementById('record-details');

    try {
        const res = await fetch(`/api/patients/${patientId}`);
        if (!res.ok) throw new Error('Patient not found');
        const data = await res.json();

        emptyState.classList.add('hidden');
        recordDetails.classList.remove('hidden');

        // Populate Header
        document.getElementById('detail-patient-id').textContent = data.patientId;
        document.getElementById('detail-name').textContent = data.onChain.name || 'Anonymous';
        document.getElementById('detail-hospital').textContent = data.onChain.hospital;
        document.getElementById('detail-demographics').textContent = `${data.onChain.age || '--'} yrs • ${data.onChain.gender || '--'} • Blood: ${data.onChain.bloodType || '--'}`;

        // Verified Status
        const hashBadge = document.getElementById('badge-hash-status');
        if (data.isHashVerified) {
            hashBadge.className = 'badge badge-verified';
            hashBadge.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> SHA-256 Hash Verified`;
        } else {
            hashBadge.className = 'badge';
            hashBadge.style.color = '#f87171';
            hashBadge.style.borderColor = '#f87171';
            hashBadge.textContent = 'Hash Mismatch!';
        }

        // Populate On-Chain Tab
        document.getElementById('detail-record-hash').textContent = data.onChain.recordHash;
        document.getElementById('detail-condition-hash').textContent = data.onChain.medicalConditionHash || '--';
        document.getElementById('detail-medication-hash').textContent = data.onChain.medicationHash || '--';
        document.getElementById('detail-test-hash').textContent = data.onChain.testResultsHash || '--';
        document.getElementById('detail-billing-hash').textContent = data.onChain.billingAmountHash || '--';

        document.getElementById('detail-created-by').textContent = data.onChain.createdBy;
        document.getElementById('detail-created-at').textContent = data.onChain.createdAt;
        document.getElementById('detail-updated-by').textContent = data.onChain.updatedBy;
        document.getElementById('detail-updated-at').textContent = data.onChain.updatedAt;

        // Populate Decrypted Off-chain Tab
        const dec = data.offChainDecrypted || {};
        document.getElementById('detail-decrypted-condition').textContent = dec.medicalCondition || '--';
        document.getElementById('detail-decrypted-medication').textContent = dec.medication || '--';
        document.getElementById('detail-decrypted-test').textContent = dec.testResults || '--';
        document.getElementById('detail-decrypted-billing').textContent = dec.billingAmount ? `$${Number(dec.billingAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '--';

        // Populate Raw Encrypted LevelDB
        document.getElementById('detail-raw-ciphertext').textContent = JSON.stringify(data.offChainEncrypted, null, 2);

        // Populate ACL Tab
        renderAclMatrix(data.onChain.accessControl);

        // Populate Audit History Tab
        await loadAuditHistory(patientId);

    } catch (err) {
        console.error('Failed to load patient details:', err);
    }
}

// Render ACL Matrix
function renderAclMatrix(acl) {
    const container = document.getElementById('acl-matrix');
    const orgs = Object.keys(acl || {});

    if (orgs.length === 0) {
        container.innerHTML = '<div class="loading-state">No access permissions configured</div>';
        return;
    }

    container.innerHTML = orgs.map(org => {
        const roles = acl[org] || [];
        return `
            <div class="acl-row">
                <div class="acl-org">${org}</div>
                <div class="acl-roles">
                    ${roles.map(r => `<span class="role-pill">${r}</span>`).join('')}
                    ${org !== 'HospitalAMSP' ? `<button class="btn btn-sm btn-outline btn-revoke" data-org="${org}">Revoke</button>` : ''}
                </div>
            </div>
        `;
    }).join('');

    // Attach revoke handlers
    container.querySelectorAll('.btn-revoke').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const org = e.target.getAttribute('data-org');
            await handleRevokeAccess(org);
        });
    });
}

// Load Audit History
async function loadAuditHistory(patientId) {
    const timelineEl = document.getElementById('audit-timeline');
    try {
        const res = await fetch(`/api/patients/${patientId}/history`);
        const history = await res.json();

        if (history.length === 0) {
            timelineEl.innerHTML = '<div class="loading-state">No historical transactions found</div>';
            return;
        }

        timelineEl.innerHTML = history.map(item => `
            <div class="timeline-item">
                <span class="timeline-dot"></span>
                <div class="timeline-header">
                    <span class="timeline-action">${item.action} • <small style="color:var(--cyan); font-family:var(--font-mono);">${item.caller || ''}</small></span>
                    <span class="timeline-time">${item.timestamp}</span>
                </div>
                <div class="timeline-details">${item.details}</div>
            </div>
        `).join('');
    } catch (err) {
        timelineEl.innerHTML = `<div class="loading-state">Error loading audit: ${err.message}</div>`;
    }
}

// Handle Grant Access
async function handleGrantAccess() {
    if (!currentPatientId) return;

    const targetOrg = document.getElementById('select-grant-org').value;
    const accessType = document.getElementById('select-grant-role').value;

    try {
        const res = await fetch(`/api/patients/${currentPatientId}/grant-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetOrg, accessType })
        });
        const data = await res.json();
        if (data.success) {
            renderAclMatrix(data.accessControl);
            await loadAuditHistory(currentPatientId);
        }
    } catch (err) {
        alert('Failed to grant access: ' + err.message);
    }
}

// Handle Revoke Access
async function handleRevokeAccess(targetOrg) {
    if (!currentPatientId) return;

    try {
        const res = await fetch(`/api/patients/${currentPatientId}/revoke-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetOrg })
        });
        const data = await res.json();
        if (data.success) {
            renderAclMatrix(data.accessControl);
            await loadAuditHistory(currentPatientId);
        }
    } catch (err) {
        alert('Failed to revoke access: ' + err.message);
    }
}

// Handle Create Patient Form
async function handleCreatePatient(e) {
    e.preventDefault();

    const payload = {
        name: document.getElementById('input-name').value,
        age: document.getElementById('input-age').value,
        gender: document.getElementById('input-gender').value,
        bloodType: document.getElementById('input-blood-type').value,
        hospital: document.getElementById('input-hospital').value,
        doctor: document.getElementById('input-doctor').value,
        medicalCondition: document.getElementById('input-condition').value,
        medication: document.getElementById('input-medication').value,
        testResults: document.getElementById('input-test-results').value,
        billingAmount: document.getElementById('input-billing').value,
        insuranceProvider: document.getElementById('input-insurance').value,
        roomNumber: document.getElementById('input-room').value,
        admissionType: 'Elective',
        dateOfAdmission: new Date().toISOString().substring(0, 10),
        dischargeDate: ''
    };

    try {
        const res = await fetch('/api/patients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('create-modal').classList.add('hidden');
            document.getElementById('create-patient-form').reset();
            await loadStats();
            await loadPatients();
            selectPatient(data.patientId);
        } else {
            alert('Failed: ' + data.error);
        }
    } catch (err) {
        alert('Error creating patient: ' + err.message);
    }
}

// Handle Quick Ingest
async function handleQuickIngest() {
    const btn = document.getElementById('btn-quick-ingest');
    btn.disabled = true;
    btn.textContent = 'Ingesting 10 rows...';

    try {
        const res = await fetch('/api/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 10 })
        });
        const data = await res.json();
        if (data.success) {
            await loadStats();
            await loadPatients();
        }
    } catch (err) {
        alert('Ingest error: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg> Ingest Dataset`;
    }
}

// ============================================================================
// AI BLOCKCHAIN ASSISTANT CONTROLLER
// ============================================================================
async function initAiAssistant() {
    const fabBtn = document.getElementById('ai-fab-btn');
    const drawer = document.getElementById('ai-drawer');
    const closeBtn = document.getElementById('ai-drawer-close');
    const clearBtn = document.getElementById('ai-clear-btn');
    const inputForm = document.getElementById('ai-input-form');
    const queryInput = document.getElementById('ai-query-input');
    const callerOrgSelect = document.getElementById('ai-caller-org');

    if (!fabBtn || !drawer) return;

    // Toggle drawer
    fabBtn.addEventListener('click', () => {
        drawer.classList.toggle('open');
        if (drawer.classList.contains('open')) {
            queryInput.focus();
        }
    });

    closeBtn.addEventListener('click', () => {
        drawer.classList.remove('open');
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && drawer.classList.contains('open')) {
            drawer.classList.remove('open');
        }
    });

    // Clear chat
    clearBtn.addEventListener('click', () => {
        const messagesEl = document.getElementById('ai-messages');
        messagesEl.innerHTML = `
            <div class="ai-bubble agent">
                <div class="bubble-header"><span class="agent-tag">🤖 Fabric AI Assistant</span></div>
                <div class="bubble-body">Chat history cleared. How can I assist you with the healthcare blockchain ledger?</div>
            </div>
        `;
    });

    // Handle Quick Chips
    document.querySelectorAll('.ai-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const prompt = chip.getAttribute('data-prompt');
            queryInput.value = prompt;
            sendAiQuery(prompt);
            queryInput.value = '';
        });
    });

    // Form submission
    inputForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = queryInput.value.trim();
        if (!text) return;
        queryInput.value = '';
        sendAiQuery(text);
    });

    // Check backend AI engine status
    await checkAiEngineStatus();
}

async function checkAiEngineStatus() {
    const badge = document.getElementById('ai-engine-badge');
    const indicator = document.getElementById('ai-status-indicator');

    try {
        const res = await fetch('/api/ai/status');
        if (res.ok) {
            const data = await res.json();
            badge.textContent = data.engine;
            indicator.className = 'ai-status-dot online';
        } else {
            badge.textContent = 'Standby';
            indicator.className = 'ai-status-dot';
        }
    } catch (e) {
        badge.textContent = 'Offline';
        indicator.className = 'ai-status-dot';
    }
}

function parseMarkdownToHtml(md) {
    if (!md) return '';
    let html = md
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    // Headings
    html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');

    // Bold & italic
    html = html.replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/gim, '<em>$1</em>');

    // Inline code
    html = html.replace(/`([^`]+)`/gim, '<code>$1</code>');

    // List items
    html = html.replace(/^\s*-\s+(.*$)/gim, '<li>$1</li>');
    html = html.replace(/^\s*\d+\.\s+(.*$)/gim, '<li>$1</li>');
    html = html.replace(/(<li>[\s\S]*?<\/li>)/gim, '<ul>$1</ul>');
    html = html.replace(/<\/ul>\s*<ul>/gim, '');

    // Line breaks
    html = html.replace(/\n\n/g, '<br><br>');
    html = html.replace(/\n/g, '<br>');

    return html;
}

function appendAiMessage(sender, content, options = {}) {
    const messagesEl = document.getElementById('ai-messages');
    const bubble = document.createElement('div');
    bubble.className = `ai-bubble ${sender}`;

    if (sender === 'agent') {
        const header = document.createElement('div');
        header.className = 'bubble-header';
        header.innerHTML = `
            <span class="agent-tag">🤖 Fabric AI (${options.engine || 'Engine'})</span>
            <span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        `;
        bubble.appendChild(header);

        // Render tool badges if any were executed
        if (options.tools && options.tools.length > 0) {
            const toolsList = document.createElement('div');
            toolsList.className = 'ai-tools-list';
            options.tools.forEach(t => {
                const pill = document.createElement('div');
                pill.className = 'ai-tool-pill';
                const argsStr = Object.values(t.args || {}).join(', ');
                pill.innerHTML = `⚙️ <strong>${t.name}</strong>(${argsStr})`;
                toolsList.appendChild(pill);
            });
            bubble.appendChild(toolsList);
        }
    }

    const body = document.createElement('div');
    body.className = 'bubble-body';
    if (sender === 'user') {
        body.textContent = content;
    } else {
        body.innerHTML = parseMarkdownToHtml(content);
    }
    bubble.appendChild(body);

    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
}

async function sendAiQuery(prompt) {
    const messagesEl = document.getElementById('ai-messages');
    const callerOrgSelect = document.getElementById('ai-caller-org');
    const callerOrg = callerOrgSelect ? callerOrgSelect.value : 'HospitalAMSP';

    // 1. Render User Message
    appendAiMessage('user', prompt);

    // 2. Render Thinking Indicator
    const thinkingBubble = document.createElement('div');
    thinkingBubble.className = 'ai-bubble agent';
    thinkingBubble.id = 'ai-thinking-bubble';
    thinkingBubble.innerHTML = `
        <div class="ai-thinking">
            <span>Querying Fabric chaincode & LevelDB</span>
            <div class="ai-thinking-dots">
                <span></span><span></span><span></span>
            </div>
        </div>
    `;
    messagesEl.appendChild(thinkingBubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const sendBtn = document.getElementById('ai-send-btn');
    if (sendBtn) sendBtn.disabled = true;

    try {
        const res = await fetch('/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, callerOrg })
        });

        const thinking = document.getElementById('ai-thinking-bubble');
        if (thinking) thinking.remove();

        if (!res.ok) {
            const errData = await res.json();
            appendAiMessage('agent', `⚠️ **Error**: ${errData.error || 'Request failed'}`);
            return;
        }

        const data = await res.json();
        appendAiMessage('agent', data.response, {
            engine: data.engine,
            tools: data.executedTools
        });

        // If the query granted access or modified state, refresh main dashboard lists
        const lowerPrompt = prompt.toLowerCase();
        if (lowerPrompt.includes('grant') || lowerPrompt.includes('revoke') || lowerPrompt.includes('register') || lowerPrompt.includes('update')) {
            await loadStats();
            await loadPatients();
            if (currentPatientId) {
                await selectPatient(currentPatientId);
            }
        }
    } catch (err) {
        const thinking = document.getElementById('ai-thinking-bubble');
        if (thinking) thinking.remove();
        appendAiMessage('agent', `❌ **Connection Failure**: Unable to reach AI endpoint (${err.message}).`);
    } finally {
        if (sendBtn) sendBtn.disabled = false;
    }
}

