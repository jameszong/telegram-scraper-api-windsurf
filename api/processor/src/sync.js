import { TelegramClient } from 'telegram';
import { ProcessorAuthService } from './auth.js';

// BigInt helper function
function toBigInt(val) {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'string') return BigInt(val);
  if (typeof val === 'number') return BigInt(val);
  return 0n;
}

export class ProcessorSyncService {
  constructor(env) {
    this.env = env;
    this.authService = new ProcessorAuthService(env);
  }

  async getTargetChannel() {
    try {
      const result = await this.env.DB.prepare(
        'SELECT value FROM kv_store WHERE key = ?'
      ).bind('target_channel_id').first();
      
      return result ? String(result.value) : null;
    } catch (error) {
      console.error('Error getting target channel:', error);
      return null;
    }
  }

  async getClient() {
    return await this.authService.getClient();
  }

  async getR2PublicUrl() {
    return await this.authService.getR2PublicUrl();
  }

  // Phase B: Media processing only
  async processMediaMessage(pendingMessage) {
    try {
      console.log(`[Processor] Starting media processing for message ${pendingMessage.telegram_message_id}`);

      const targetChannelId = await this.getTargetChannel();

      if (!targetChannelId) {
        throw new Error('No target channel selected');
      }

      // Connect to Telegram
      const client = await this.getClient();
      await client.connect();

      // Get channel entity
      const channelBigInt = toBigInt(pendingMessage.chat_id);
      console.log(`[Processor] Resolving channel entity for chat_id: ${pendingMessage.chat_id} -> ${channelBigInt}`);
      
      const channel = await client.getEntity(channelBigInt);
      console.log(`[Processor] Successfully resolved channel entity`);

      // Fetch the specific message
      const msgIdNum = Number(pendingMessage.telegram_message_id);
      console.log(`[Processor] Fetching message ID: ${pendingMessage.telegram_message_id} -> ${msgIdNum}`);
      
      const messages = await client.getMessages(channel, {
        ids: [msgIdNum]
      });

      if (!messages || messages.length === 0) {
        throw new Error(`Message ${pendingMessage.telegram_message_id} not found`);
      }

      const message = messages[0];
      if (!message.media) {
        throw new Error(`Message ${pendingMessage.telegram_message_id} has no media`);
      }

      console.log(`[Processor] Downloading media for message ${message.id}, type: ${message.media.className}`);

      // TURBO MODE: Photo-only processing with 20MB limit for high-res photos
      if (!message.media.photo) {
        console.log(`[Processor] Skipping non-photo media: ${message.media.className}`);
        return {
          success: true,
          skipped: true,
          reason: `Non-photo media type: ${message.media.className}`,
          mediaKey: null
        };
      }

      const MAX_SIZE = 20 * 1024 * 1024; // 20MB for high-res photos
      let fileSize = 0;
      
      // Only process photos, calculate max size from available variants
      if (message.media.photo && message.media.photo.sizes) {
        let maxSize = 0;
        for (const size of message.media.photo.sizes) {
          if (size.size) {
            const sizeNum = Number(size.size);
            if (sizeNum > maxSize) maxSize = sizeNum;
          }
        }
        fileSize = maxSize;
        console.log(`[Processor] Photo max size: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);
      }
      
      if (fileSize > MAX_SIZE) {
        console.log(`[Processor] Skipping photo ${message.id}: Size ${(fileSize / 1024 / 1024).toFixed(2)}MB > 20MB limit.`);
        
        return {
          success: true,
          skipped: true,
          reason: `Photo size ${(fileSize / 1024 / 1024).toFixed(2)}MB exceeds 20MB limit`,
          mediaKey: null
        };
      }
      
      console.log(`[Processor] Photo size check passed (${fileSize} bytes <= 20MB), proceeding with download`);

      // TURBO MODE: Fast photo download without artificial delays
      const downloadPromise = client.downloadMedia(message, { workers: 1 });
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Download timed out > 30s')), 30000)
      );

      let buffer;
      try {
        buffer = await Promise.race([downloadPromise, timeoutPromise]);
      } catch (error) {
        console.error(`[Processor] Error/Timeout for message ${message.id}:`, error.message);
        
        return {
          success: false,
          error: error.message,
          mediaKey: null
        };
      }
      
      // CRITICAL: Verify buffer before uploading
      if (!buffer || buffer.length === 0) {
        console.error(`[Processor] Downloaded empty buffer for message ${message.id}`);
        return {
          success: false,
          error: 'Downloaded empty buffer',
          mediaKey: null
        };
      }
      
      console.log(`[Processor] Successfully downloaded media (${buffer.length} bytes)`);

      // Generate R2 key
      const chatIdStr = String(targetChannelId);
      const messageIdStr = message.id.toString();
      const extension = this.getMediaExtension(message.media.className);
      const key = `media/${chatIdStr}_${messageIdStr}_${Date.now()}.${extension}`;

      console.log(`[Processor] Uploading to R2: ${key}`);

      // Upload to R2 with error handling
      try {
        await this.env.BUCKET.put(key, buffer, {
          httpMetadata: {
            contentType: this.getContentType(message.media.className)
          }
        });
        console.log(`[Processor] Successfully uploaded to R2: ${key}`);
      } catch (uploadError) {
        console.error(`[Processor] R2 upload failed for message ${message.id}:`, uploadError);
        return {
          success: false,
          error: 'R2 upload failed: ' + uploadError.message,
          mediaKey: null
        };
      }

      // Update database with media key and completed status
      await this.env.DB.prepare(`
        UPDATE messages SET media_key = ?, media_status = 'completed' WHERE id = ?
      `).bind(key, String(pendingMessage.id)).run();

      // Also save to media table for compatibility
      const mediaData = {
        type: this.getMediaType(message.media.className),
        extension: extension,
        size: buffer.length,
        mime_type: this.getContentType(message.media.className),
        r2_key: key
      };

      await this.saveMediaRecord(String(pendingMessage.id), mediaData);

      // Free memory
      buffer = null;

      console.log(`[Processor] Media processing completed for message ${pendingMessage.telegram_message_id}`);

      return {
        success: true,
        mediaKey: key,
        mediaData: mediaData
      };

    } catch (error) {
      console.error(`[Processor] Error processing media for message ${pendingMessage.telegram_message_id}:`, error);
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Helper methods for media processing
  getMediaExtension(mediaClassName) {
    switch (mediaClassName) {
      case 'MessageMediaPhoto':
        return 'jpg';
      case 'MessageMediaVideo':
        return 'mp4';
      case 'MessageMediaDocument':
        return 'bin';
      default:
        return 'bin';
    }
  }

  getMediaType(mediaClassName) {
    switch (mediaClassName) {
      case 'MessageMediaPhoto':
        return 'photo';
      case 'MessageMediaVideo':
        return 'video';
      case 'MessageMediaDocument':
        return 'document';
      default:
        return 'unknown';
    }
  }

  getContentType(mediaClassName) {
    switch (mediaClassName) {
      case 'MessageMediaPhoto':
        return 'image/jpeg';
      case 'MessageMediaVideo':
        return 'video/mp4';
      case 'MessageMediaDocument':
        return 'application/octet-stream';
      default:
        return 'application/octet-stream';
    }
  }

  async saveMediaRecord(messageId, mediaData) {
    try {
      await this.env.DB.prepare(`
        INSERT INTO media (message_id, r2_key, file_type, file_size, mime_type)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        messageId,
        mediaData.r2_key,
        mediaData.type,
        mediaData.size,
        mediaData.mime_type
      ).run();

      console.log(`[Processor] Saved media record for message ${messageId}`);
    } catch (error) {
      console.error('[Processor] Error saving media record:', error);
      throw error;
    }
  }
}
