export const getUsers = () => JSON.parse(localStorage.getItem("xanvia_users")) || [];
export const saveUsers = (users) => localStorage.setItem("xanvia_users", JSON.stringify(users));

export function createUser(name, email, password) {
  const users = getUsers();
  if (users.find(u => u.email === email)) return null;
  const user = { id: Date.now(), name, email, password };
  users.push(user);
  saveUsers(users);
  return user;
}

export function findUser(email, password) {
  return getUsers().find(u => u.email === email && u.password === password) || null;
}