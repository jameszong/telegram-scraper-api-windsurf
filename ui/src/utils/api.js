// Use environment variable if available, otherwise fallback (for local dev)
const API_BASE = import.meta.env.VITE_API_URL || "https://telegram-archiver-api.iflove29.workers.dev";

// Create a fetch function that adds the access key to all requests
export const createAuthenticatedFetch = () => {
  return async (url, options = {}) => {
    // Get access key from localStorage (since we can't use hooks in utils)
    const accessKey = localStorage.getItem('access-key-storage');
    const parsedAccessKey = accessKey ? JSON.parse(accessKey).state?.accessKey : null;
    
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };
    
    if (parsedAccessKey) {
      headers['X-Access-Key'] = parsedAccessKey;
    }
    
    return fetch(url, {
      ...options,
      headers,
    });
  };
};

export const authenticatedFetch = createAuthenticatedFetch();
export { API_BASE };
