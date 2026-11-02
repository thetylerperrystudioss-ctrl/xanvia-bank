// 1. Check for the token and user data
const token = localStorage.getItem("xanvia_token");
const userStr = localStorage.getItem("xanvia_user");

// 2. If they don't exist, kick the user back to login
if (!token || !userStr) {
  window.location.href = "login.html";
}

// 3. Parse the user object
let user;
try {
  user = JSON.parse(userStr);
} catch (e) {
  window.location.href = "login.html";
}

// 4. Once the page loads, set up the UI
document.addEventListener("DOMContentLoaded", () => {
  
  // Display the user's first name in the dashboard header
  const nameEl = document.querySelector("#user-name");
  if (nameEl && user) {
    nameEl.textContent = user.name.split(' ')[0];
  }
  
  // Set up the Logout button
  const logoutBtn = document.querySelector("#logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      localStorage.removeItem("xanvia_token");
      localStorage.removeItem("xanvia_user");
      window.location.href = "login.html";
    });
  }
});