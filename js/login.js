const form = document.querySelector("#login-form");
const msg = document.querySelector("#auth-msg");

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.className = "auth-msg";
    msg.textContent = "Authenticating...";
    
    const identifier = document.querySelector("#email").value;
    const pass = document.querySelector("#password").value;
    
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password: pass })
      });
      
      const data = await response.json();
      
      if (data.error) {
        msg.textContent = data.error;
        msg.className = "auth-msg error";
        return;
      }
      
      // Save the token and user data
      localStorage.setItem("xanvia_token", "token_" + data.user.id);
      localStorage.setItem("xanvia_user", JSON.stringify(data.user));
      
      msg.textContent = `Welcome back, ${data.user.name.split(' ')[0]}!`;
      msg.className = "auth-msg success";
      
      // CRITICAL FIX: Redirect to hub.html
      setTimeout(() => { window.location.href = "hub.html"; }, 1000);
      
    } catch (error) {
      msg.textContent = "Server error. Please try again later.";
      msg.className = "auth-msg error";
    }
  });
}