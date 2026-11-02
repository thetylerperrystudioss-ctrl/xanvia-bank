const form = document.querySelector("#login-form");
const msg = document.querySelector("#auth-msg");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  msg.className = "auth-msg";
  
  const email = document.querySelector("#email").value;
  const pass = document.querySelector("#password").value;
  
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass })
    });
    
    const data = await response.json();
    
    if (data.error) {
      msg.textContent = data.error;
      msg.className = "auth-msg error";
      return;
    }
    
    // Save the user to the session so the dashboard knows who is logged in
    localStorage.setItem("xanvia_session", JSON.stringify(data.user));
    
    msg.textContent = `Welcome back, ${data.user.name.split(' ')[0]}!`;
    msg.className = "auth-msg success";
    
    setTimeout(() => { window.location.href = "dashboard.html"; }, 1000);
    
  } catch (error) {
    msg.textContent = "Server error. Please try again later.";
    msg.className = "auth-msg error";
  }
});