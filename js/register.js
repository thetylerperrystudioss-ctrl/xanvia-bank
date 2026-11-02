const form = document.querySelector("#register-form");
const msg = document.querySelector("#auth-msg");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  msg.className = "auth-msg"; // Reset message
  
  const name = document.querySelector("#name").value;
  const email = document.querySelector("#email").value;
  const pass = document.querySelector("#password").value;
  
  try {
    const response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password: pass })
    });
    
    const data = await response.json();
    
    if (data.error) {
      msg.textContent = data.error;
      msg.className = "auth-msg error";
      return;
    }
    
    msg.textContent = "Account created securely! Redirecting to login...";
    msg.className = "auth-msg success";
    setTimeout(() => { window.location.href = "login.html"; }, 1500);
    
  } catch (error) {
    msg.textContent = "Server error. Please try again later.";
    msg.className = "auth-msg error";
  }
});