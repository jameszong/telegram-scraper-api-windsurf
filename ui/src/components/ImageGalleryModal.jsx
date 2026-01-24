import React, { useState, useEffect, useCallback } from 'react';
import { VIEWER_URL } from '../utils/api';

const ImageGalleryModal = ({ isOpen, onClose, images, initialIndex = 0 }) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  // Reset current index when modal opens with new images
  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(initialIndex);
    }
  }, [isOpen, initialIndex]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e) => {
    if (!isOpen) return;
    
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        goToPrevious();
        break;
      case 'ArrowRight':
        e.preventDefault();
        goToNext();
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden'; // Prevent background scrolling
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'unset'; // Restore scrolling
    };
  }, [isOpen, handleKeyDown]);

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
  };

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!isOpen || !images || images.length === 0) {
    return null;
  }

  const currentImage = images[currentIndex];
  
  // Defensive field mapping: handle flat or nested keys
  const r2Key = currentImage.r2_key || currentImage.media?.r2_key || currentImage.media_key;
  
  console.log('[ImageGalleryModal] Current image field mapping:', {
    imageIndex: currentIndex,
    r2_key: currentImage.r2_key,
    media_r2_key: currentImage.media?.r2_key,
    media_key: currentImage.media_key,
    finalR2Key: r2Key,
    media_url: currentImage.media_url
  });
  
  if (!r2Key && !currentImage.media_url) {
    console.error('[ImageGalleryModal] No media key found for image:', currentImage);
    return null;
  }
  
  const imageUrl = r2Key ? `${VIEWER_URL}/media/${r2Key}` : currentImage.media_url;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-90"
      onClick={handleBackdropClick}
    >
      <div className="relative max-w-7xl max-h-full p-4">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 text-white bg-black bg-opacity-50 rounded-full hover:bg-opacity-75 transition-colors"
          aria-label="Close gallery"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        {/* Navigation buttons */}
        {images.length > 1 && (
          <>
            <button
              onClick={goToPrevious}
              className="absolute left-4 top-1/2 transform -translate-y-1/2 p-3 text-white bg-black bg-opacity-50 rounded-full hover:bg-opacity-75 transition-colors"
              aria-label="Previous image"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            <button
              onClick={goToNext}
              className="absolute right-4 top-1/2 transform -translate-y-1/2 p-3 text-white bg-black bg-opacity-50 rounded-full hover:bg-opacity-75 transition-colors"
              aria-label="Next image"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </>
        )}

        {/* Main image */}
        <div className="flex items-center justify-center">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={`Image ${currentIndex + 1}`}
              className="max-w-full max-h-[80vh] object-contain rounded-lg"
              onError={(e) => {
                e.target.onerror = null;
                e.target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="100"%3E%3Crect width="100" height="100" fill="%23ccc"/%3E%3Ctext x="50" y="50" text-anchor="middle" dy=".3em" fill="%23666"%3EFailed to load%3C/text%3E%3C/svg%3E';
              }}
            />
          ) : (
            <div className="text-white text-center">
              <div className="w-64 h-64 bg-gray-700 rounded-lg flex items-center justify-center">
                <span>No image available</span>
              </div>
            </div>
          )}
        </div>

        {/* Image counter */}
        {images.length > 1 && (
          <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 text-white bg-black bg-opacity-50 px-3 py-1 rounded-full">
            {currentIndex + 1} / {images.length}
          </div>
        )}

        {/* Image info */}
        {currentImage.text && (
          <div className="absolute bottom-4 left-4 right-4 text-white text-center bg-black bg-opacity-50 p-2 rounded-lg">
            <p className="text-sm truncate">{currentImage.text}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default ImageGalleryModal;
