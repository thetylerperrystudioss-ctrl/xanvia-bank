// 1. Secure Auth Guard
const token = localStorage.getItem("xanvia_token");
const userStr = localStorage.getItem("xanvia_user");

if (!token || !userStr) {
  window.location.href = "login.html";
}

const user = JSON.parse(userStr);

// 2. Display User Info
document.addEventListener("DOMContentLoaded", () => {
  const nameEl = document.querySelector("#user-name");
  if (nameEl) nameEl.textContent = user.name.split(' ')[0];
  
  // Note: We are keeping your existing dashboard render logic for now.
  // In the next stage, we can build a route to fetch account balances from the database.
  console.log("Dashboard loaded securely for:", user.email);
});

// 3. Logout
const logoutBtn = document.querySelector("#logout-btn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    localStorage.removeItem("xanvia_token");
    localStorage.removeItem("xanvia_user");
    window.location.href = "login.html";
  });
}