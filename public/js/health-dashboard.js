console.log("✅ Dashboard script loaded");

const apiKey = document.querySelector('meta[name="x-api-key"]')?.content;
console.log("Using API Key:", apiKey);

const container = document.getElementById("health-container");

async function loadHealthDashboard() {
  try {
    const res = await fetch('/health/detailed', {
      method: 'GET',
      headers: { 'x-api-key': apiKey || '' }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    container.innerHTML = "";

    // Refresh button
    const refreshBtn = document.createElement("button");
    refreshBtn.textContent = "🔄 Refresh";
    refreshBtn.className = "refresh-btn";
    refreshBtn.onclick = () => location.reload();
    container.appendChild(refreshBtn);

    // Summary section
    const summary = document.createElement("div");
    summary.className = `summary ${data.status}`;
    summary.innerHTML = `
      <p><strong>Status:</strong> ${data.status.toUpperCase()}</p>
      <p><strong>Version:</strong> ${data.version}</p>
      <p><strong>Checked At:</strong> ${new Date(data.timestamp).toLocaleString()}</p>
    `;
    container.appendChild(summary);

    // Status icons
    const statusIcons = {
      ok: '✅',
      fail: '❌',
      degraded: '⚠️'
    };

    // Individual service checks
    for (const [service, check] of Object.entries(data.checks || {})) {
      const card = document.createElement("div");
      card.className = `card ${check.status}`;
      const icon = statusIcons[check.status] || '';
      card.innerHTML = `
        <h3>${icon} ${service}</h3>
        <p>Status: <strong>${check.status}</strong></p>
        ${
          check.error
            ? `<details><summary>Error</summary><pre>${check.error}</pre></details>`
            : ""
        }
      `;
      container.appendChild(card);
    }

  } catch (err) {
    container.innerHTML = `<div class="error">❌ Failed to fetch health status: ${err.message}</div>`;
  }
}

loadHealthDashboard();
