import axios from 'axios';
import { useAuthStore } from '@/store/authStore';
import toast from 'react-hot-toast';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Logout on 401
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response) {
      const status = error.response.status;
      const msg = error.response.data?.error || 'An error occurred';

      if (status === 401) {
        toast.error('Session expired. Please log in again.');
        useAuthStore.getState().logout();
        window.location.href = '/login';
      } else if (status === 403 || status === 429) {
        // Global error toasts for blocklist (403) and rate limits (429)
        toast.error(msg);
      }
    }
    return Promise.reject(error);
  },
);

export default api;
