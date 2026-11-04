const token = localStorage.getItem("xanvia_token");
const userStr = localStorage.getItem("xanvia_user");

if (!token || !userStr) {
  window.location.href = "login.html";
} else {
  const user = JSON.parse(userStr);
  const formatUSD = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);

  // Setup UI
  document.getElementById('user-display-name').textContent = user.name;
  document.getElementById('user-display-email').textContent = user.email;
  document.getElementById('greeting-name').textContent = user.name.split(' ')[0];
  document.getElementById('user-avatar').textContent = user.name.charAt(0).toUpperCase();
  document.getElementById('current-date').textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  // Sidebar toggle
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if(document.getElementById('menu-btn')) {
      document.getElementById('menu-btn').addEventListener('click', () => { sidebar.classList.add('open'); overlay.classList.add('open'); });
      overlay.addEventListener('click', () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); });
  }

  // Logout
  document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem("xanvia_token");
    localStorage.removeItem("xanvia_user");
    window.location.href = "login.html";
  });

  // Fetch Live Data
  async function loadDashboard() {
    try {
      const res = await fetch(`/api/accounts/${user.id}`);
      const data = await res.json();
      
      if (data.error) throw new Error(data.error);

      const checking = data.checking || 0;
      const loan = data.loan || 0;
      const total = checking - loan;

      document.getElementById('total-balance').textContent = formatUSD(total);
      document.getElementById('checking-bal').textContent = formatUSD(checking);
      document.getElementById('savings-bal').textContent = formatUSD(0);
      document.getElementById('brokerage-bal').textContent = formatUSD(0);

      // Fetch real transactions
      const txRes = await fetch(`/api/transactions/${user.id}`);
      const txs = await txRes.json();
      
      const table = document.getElementById('transactions-table');
      if (table) {
          table.innerHTML = txs.length > 0 ? txs.slice(0, 5).map(tx => `
            <tr>
              <td><strong>${tx.type.replace(/_/g, ' ')}</strong></td>
              <td>${new Date(tx.created_at).toLocaleDateString()}</td>
              <td>${tx.status}</td>
              <td style="color: ${tx.type.includes('DEPOSIT') ? 'green' : 'red'}">${formatUSD(tx.amount)}</td>
            </tr>
          `).join('') : '<tr><td colspan="4" style="text-align:center;">No transactions yet.</td></tr>';
      }

    } catch (err) {
      console.error("Dashboard load error:", err);
    }
  }
  
  loadDashboard();
}