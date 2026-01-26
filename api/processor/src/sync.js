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
    // 添加详细日志以追踪消息处理
    console.log(`[Processor] Starting media processing for message ${pendingMessage.telegram_message_id} with detailed logging`);
    
    try {
      console.log(`[Processor] Starting media processing for message ${pendingMessage.telegram_message_id}`);

      const targetChannelId = await this.getTargetChannel();

      if (!targetChannelId) {
        throw new Error('No target channel selected');
      }

      // Connect to Telegram with robust initialization
      const client = await this.getClient();
      console.log(`[Processor] Initializing Telegram client connection...`);
      
      // Ensure client is properly connected with retry logic
      let connectionAttempts = 0;
      const maxConnectionAttempts = 3;
      
      while (connectionAttempts < maxConnectionAttempts) {
        try {
          // 先断开连接再重新连接，确保连接状态清晰
          try { await client.disconnect(); } catch (e) { /* 忽略断开错误 */ }
          
          await client.connect();
          console.log(`[Processor] Telegram client connected successfully (attempt ${connectionAttempts + 1})`);
          
          // 验证连接状态
          const self = await client.getMe();
          if (self) {
            console.log(`[Processor] Connection verified - User: ${self.firstName || self.id}`);
            break;
          } else {
            throw new Error('Connection verification failed - getMe returned empty result');
          }
        } catch (connError) {
          connectionAttempts++;
          console.error(`[Processor] Connection attempt ${connectionAttempts} failed:`, connError.message);
          
          if (connectionAttempts >= maxConnectionAttempts) {
            throw new Error(`Failed to establish Telegram connection after ${maxConnectionAttempts} attempts: ${connError.message}`);
          }
          
          // 等待时间按指数增长，避免频繁重试
          const waitTime = Math.min(1000 * Math.pow(2, connectionAttempts), 8000); // 指数退避，最长8秒
          console.log(`[Processor] Waiting ${waitTime}ms before next connection attempt`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

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
        
        // Check for FloodWaitError
        if (error.message && error.message.includes('FloodWaitError')) {
          const waitSeconds = error.message.match(/(\d+)s/) ? parseInt(error.message.match(/(\d+)s/)[1]) : 60;
          console.error(`[Processor] FloodWaitError detected: need to wait ${waitSeconds} seconds`);
          
          // Fast-fail: if wait time > 5 seconds, don't wait in the worker
          if (waitSeconds > 5) {
            console.log(`[Processor] Fast-fail: wait time ${waitSeconds}s > 5s, returning immediately`);
            return {
              success: false,
              skipped: true,
              reason: "RateLimit",
              floodWait: waitSeconds,
              error: `Rate limited: Need to wait ${waitSeconds} seconds`
            };
          }
          
          // For short waits (<= 5s), we can wait in the worker
          console.log(`[Processor] Short wait time ${waitSeconds}s, waiting in worker`);
          await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
          // Retry the operation after waiting
          return {
            success: false,
            skipped: true,
            reason: "RateLimit",
            floodWait: waitSeconds,
            error: `Rate limited: Need to wait ${waitSeconds} seconds`
          };
        }
        
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
      const r2ChatIdStr = String(targetChannelId);
      const messageIdStr = message.id.toString();
      const extension = this.getMediaExtension(message.media.className);
      const key = `media/${r2ChatIdStr}_${messageIdStr}_${Date.now()}.${extension}`;

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
      console.log(`[Processor] Updating DB for message ${pendingMessage.telegram_message_id} with key: ${key}`);

      // CRITICAL: Use telegram_message_id AND chat_id as unique key to match Scanner's storage format
      const msgIdStr = String(pendingMessage.telegram_message_id);
      const chatIdStr = String(pendingMessage.chat_id);

      console.log(`[Processor] DB Update Parameters: mediaKey=${key}, telegramMessageId=${msgIdStr} (${typeof msgIdStr}), chatId=${chatIdStr} (${typeof chatIdStr}), originalMessageId=${pendingMessage.telegram_message_id}, originalChatId=${pendingMessage.chat_id}`);
      
      // PRE-UPDATE VERIFICATION: Check if message exists before updating
      const preCheckResult = await this.env.DB.prepare(`
        SELECT id, telegram_message_id, chat_id, media_status, media_key FROM messages
        WHERE telegram_message_id = ? AND chat_id = ?
      `).bind(msgIdStr, chatIdStr).first();
      
      if (!preCheckResult) {
        console.error(`[Processor] PRE-CHECK FAILED: Message NOT FOUND before update`);
        console.error(`[Processor] Search params: telegram_message_id=${msgIdStr}, chat_id=${chatIdStr}`);
        
        // Try alternative query to find the message
        const altCheck = await this.env.DB.prepare(`
          SELECT id, telegram_message_id, chat_id, media_status FROM messages
          WHERE id = ?
        `).bind(String(pendingMessage.id)).first();
        
        if (altCheck) {
          console.error(`[Processor] Found message by ID but composite key mismatch: id=${altCheck.id}, telegram_message_id=${altCheck.telegram_message_id}, chat_id=${altCheck.chat_id}`);
        }
        
        throw new Error(`Message not found in DB before update. telegram_message_id=${msgIdStr}, chat_id=${chatIdStr}`);
      }
      
      console.log(`[Processor] PRE-CHECK PASSED: Message found: id=${preCheckResult.id}, telegram_message_id=${preCheckResult.telegram_message_id}, chat_id=${preCheckResult.chat_id}, media_status=${preCheckResult.media_status}`);

      const result = await this.env.DB.prepare(`
        UPDATE messages 
        SET media_status = 'completed', media_key = ? 
        WHERE telegram_message_id = ? AND chat_id = ?
      `).bind(key, msgIdStr, chatIdStr).run();

      console.log(`[Persistence] Updated Msg ${msgIdStr}: changes=${result.meta.changes}`);
      console.log(`[DB] Message ${msgIdStr} updated, changes: ${result.meta.changes}`);

      // CRITICAL: If changes === 0, throw explicit error to stop 'false success' loop
      if (result.meta.changes === 0) {
        console.warn(`[Persistence Warning] Uploaded but DB row not found! Check ID types.`);
        const errorMsg = `CRITICAL: DB UPDATE FAILED - No rows affected for message ${msgIdStr} in chat ${chatIdStr}. This indicates a data mismatch or the message doesn't exist.`;
        console.error(`[Processor] ${errorMsg}`);
        console.error(`[Processor] Query parameters: mediaKey=${key}, telegram_message_id=${msgIdStr}, chat_id=${chatIdStr}`);

        // Check if message exists at all
        const checkResult = await this.env.DB.prepare(`
          SELECT id, telegram_message_id, chat_id, media_status FROM messages
          WHERE telegram_message_id = ? AND chat_id = ?
        `).bind(msgIdStr, chatIdStr).first();

        if (checkResult) {
          console.error(`[Processor] Message exists but update failed. Current state: id=${checkResult.id}, telegram_message_id=${checkResult.telegram_message_id}, chat_id=${checkResult.chat_id}, media_status=${checkResult.media_status}, media_key=${checkResult.media_key}`);
        } else {
          console.error(`[Processor] Message NOT FOUND in database with these parameters`);
        }

        throw new Error(errorMsg);
      }

      console.log(`[Processor] SUCCESS: DB updated for message ${msgIdStr}, ${result.meta.changes} rows affected`);

      // Also save to media table for compatibility
      const mediaData = {
        type: this.getMediaType(message.media.className),
        extension: extension,
        size: buffer.length,
        mime_type: this.getContentType(message.media.className),
        r2_key: key
      };

      await this.saveMediaRecord(pendingMessage.id, mediaData);

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
