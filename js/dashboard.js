const token = localStorage.getItem("xanvia_token");
const userStr = localStorage.getItem("xanvia_user");
if (!token || !userStr) window.location.href = "login.html";

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
document.getElementById('menu-btn').addEventListener('click', () => { sidebar.classList.add('open'); overlay.classList.add('open'); });
overlay.addEventListener('click', () => { sidebar.classList.remove('open'); overlay.classList.remove('open'); });

// Logout
document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem("xanvia_token");
  localStorage.removeItem("xanvia_user");
  window.location.href = "login.html";
});

// Fetch Live Data
async function loadDashboard() {
  try {
    const res = await fetch(`/api/dashboard/${user.id}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const { checking, savings, brokerage, loan } = data.balances;
    const total = checking + savings + brokerage - loan;

    document.getElementById('total-balance').textContent = formatUSD(total);
    document.getElementById('checking-bal').textContent = formatUSD(checking);
    document.getElementById('savings-bal').textContent = formatUSD(savings);
    document.getElementById('brokerage-bal').textContent = formatUSD(brokerage);

    const chart = document.getElementById('activity-chart');
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    chart.innerHTML = data.cashflow.map((val, i) => `
      <div class="bar" style="height: ${val}%; background: ${val > 70 ? 'var(--emerald)' : 'var(--emerald-light)'};" data-day="${days[i]}"></div>
    `).join('');

    const mockTx = [
      { desc: 'Acme Corp Payroll', date: 'Oct 24', status: 'Completed', amount: 3250.00, type: 'credit' },
      { desc: 'Whole Foods Market', date: 'Oct 23', status: 'Completed', amount: 87.42, type: 'debit' },
      { desc: 'Blue Bottle Coffee', date: 'Oct 22', status: 'Completed', amount: 6.85, type: 'debit' },
      { desc: 'Netflix Subscription', date: 'Oct 21', status: 'Completed', amount: 15.49, type: 'debit' },
    ];

    document.getElementById('transactions-table').innerHTML = mockTx.map(tx => `
      <tr>
        <td><strong>${tx.desc}</strong></td>
        <td