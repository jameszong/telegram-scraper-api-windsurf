import React, { useState } from 'react';
import { useAccessKeyStore } from '../store/accessKeyStore';

const AccessGatekeeper = ({ children }) => {
  const { accessKey, isUnlocked, setAccessKey, setError, validateKey, error } = useAccessKeyStore();
  const [inputKey, setInputKey] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    if (!validateKey(inputKey)) {
      setIsSubmitting(false);
      return;
    }

    // Test the access key by making a request to the health endpoint
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || "https://telegram-archiver-api.iflove29.workers.dev"}/`, {
        method: 'GET',
        headers: {
          'X-Access-Key': inputKey,
        },
      });

      if (response.ok) {
        setAccessKey(inputKey);
      } else if (response.status === 401) {
        setError('Invalid access key');
      } else {
        setError('Failed to validate access key');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isUnlocked && accessKey) {
    return children;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="text-center">
          <h2 className="text-3xl font-extrabold text-gray-900">Access Required</h2>
          <p className="mt-2 text-sm text-gray-600">
            Enter your 32-character access key to continue
          </p>
        </div>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10">
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="access-key" className="block text-sm font-medium text-gray-700">
                Access Key
              </label>
              <div className="mt-1">
                <input
                  id="access-key"
                  name="access-key"
                  type="password"
                  autoComplete="off"
                  required
                  maxLength={32}
                  minLength={32}
                  value={inputKey}
                  onChange={(e) => setInputKey(e.target.value)}
                  className="appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono"
                  placeholder="Enter 32-character key"
                />
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Must be exactly 32 characters
              </p>
            </div>

            {error && (
              <div className="rounded-md bg-red-50 p-4">
                <div className="text-sm text-red-800">{error}</div>
              </div>
            )}

            <div>
              <button
                type="submit"
                disabled={isSubmitting || inputKey.length !== 32}
                className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? 'Validating...' : 'Unlock Access'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default AccessGatekeeper;
