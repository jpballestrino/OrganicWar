const TOKEN_KEY = 'conqueror_auth_token';
const USER_KEY = 'conqueror_auth_user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getUser() {
  const user = localStorage.getItem(USER_KEY);
  return user ? JSON.parse(user) : null;
}

export function setUser(user) {
  if (user) {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_KEY);
  }
}

export function isLoggedIn() {
  return !!getToken() && !!getUser();
}

export async function register(username, email, password) {
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password }),
  });
  const data = await response.json();
    
  if (!response.ok) {
    throw new Error(data.error || 'Registration failed');
  }
    
  setToken(data.token);
  setUser(data.user);
  return data.user;
}

export async function login(username, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await response.json();
    
  if (!response.ok) {
    throw new Error(data.error || 'Login failed');
  }
    
  setToken(data.token);
  setUser(data.user);
  return data.user;
}

export async function fetchProfile() {
  const token = getToken();
  if (!token) {return null;}
    
  try {
    const response = await fetch('/api/auth/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
        
    if (!response.ok) {
      clearToken();
      return null;
    }
        
    const data = await response.json();
    setUser(data.user);
    return data.user;
  } catch (err) {
    console.error('Failed to fetch profile', err);
    return null;
  }
}

export function logout() {
  clearToken();
  window.location.reload();
}
