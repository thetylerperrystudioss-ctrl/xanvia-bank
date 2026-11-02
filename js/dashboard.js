const token = localStorage.getItem("xanvia_token");
const userStr = localStorage.getItem("xanvia_user");

if (!token || !userStr) window.location.href = "login.html";

const user = JSON.parse(userStr);
const formatUSD = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);

// Mobile Sidebar
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebar-overlay');
document.getElementById('menu-btn').addEventListener('click', () => {
  sidebar.classList.add('open'); overlay.classList.add('open');
});
overlay.addEventListener('click', () => {
  sidebar.classList.remove('open'); overlay.classList.remove('open');
});

// View Switcher
window.showView = (viewName) => {
  document.getElementById('view-overview').style.display = 'none';
  document.getElementById('view-transfer').style.display = 'none';
  document.getElementById('view-loans').style.display = 'none';
  
  document.getElementById(`view-${viewName}`).style.display = 'block';
  
  const titles = { overview: 'Unified Dashboard', transfer: 'Transfers', loans: 'Loans' };
  document.getElementById('page-title').textContent = titles[viewName];
  
  sidebar.classList.remove('open'); overlay.classList.remove('open');
};

// Logout
document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem("xanvia_token");
  localStorage.removeItem("xanvia_user");
  window.location.href = "login.html";
});

// Fetch Data
async function loadDashboard() {
  try {
    const res = await fetch(`/api/dashboard/${user.id}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    document.getElementById('user-name').textContent = user.name.split(' ')[0];

    const { checking, savings, brokerage, loan } = data.balances;
    const cashTotal = checking + savings;
    const netWorth = (cashTotal + brokerage) - loan;

    document.getElementById('net-worth').textContent = formatUSD(netWorth);
    document.getElementById('cash-val').textContent = formatUSD(cashTotal);
    document.getElementById('equity-val').textContent = formatUSD(brokerage);
    document.getElementById('loan-val').textContent = formatUSD(loan);

    document.getElementById('accounts-list').innerHTML = `
      <div class="tx-row">
        <div><strong>Everyday Checking</strong></div>
        <div class="tx-amount credit">${formatUSD(checking)}</div>
      </div>
      <div class="tx-row">
        <div><strong>High-Yield Savings</strong></div>
        <div class="tx-amount credit">${formatUSD(savings)}</div>
      </div>
      <div class="tx-row">
        <div><strong>Brokerage Account</strong></div>
        <div class="tx-amount credit">${formatUSD(brokerage)}</div>
      </div>
    `;
  } catch (err) { console.error(err); }
}

// Transfer Handler
document.getElementById('transfer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const from = document.getElementById('from-acc').value;
  const to = document.getElementById('to-acc').value;
  const amount = parseFloat(document.getElementById('transfer-amt').value);
  const msg = document.getElementById('transfer-msg');

  if (from === to) { msg.textContent = "Cannot transfer to the same account."; msg.style.color = "red"; return; }
  if (amount <= 0) { msg.textContent = "Amount must be greater than 0."; msg.style.color = "red"; return; }

  try {
    const res = await fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user.id, from, to, amount })
    });
    const data = await res.json();
    
    if (data.success) {
      msg.textContent = "Transfer successful!";
      msg.style.color = "#0F8A5F";
      document.getElementById('transfer-amt').value = '';
      loadDashboard(); // Refresh balances
    } else {
      msg.textContent = data.error;
      msg.style.color = "red";
    }
  } catch (err) {
    msg.textContent = "Transfer failed.";
    msg.style.color = "red";
  }
});

loadDashboard();