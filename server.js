require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Configurations
const FRESHCHAT_API_KEY = process.env.FRESHCHAT_API_KEY;
const FRESHCHAT_API_URL = process.env.FRESHCHAT_API_URL || 'https://api.freshchat.com/v2';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const BOT_AGENT_ID = process.env.FRESHCHAT_BOT_AGENT_ID;
const HUMAN_AGENT_ID = process.env.HUMAN_AGENT_ID;

// Validate environment variables
console.log('\n' + '='.repeat(70));
console.log('🔍 Configuration Check:');
console.log('='.repeat(70));
console.log('FRESHCHAT_API_KEY:', FRESHCHAT_API_KEY ? '✅ Set' : '❌ Missing');
console.log('FRESHCHAT_API_URL:', FRESHCHAT_API_URL);
console.log('OPENAI_API_KEY:', OPENAI_API_KEY ? '✅ Set' : '❌ Missing');
console.log('ASSISTANT_ID:', ASSISTANT_ID || '❌ Missing');
console.log('BOT_AGENT_ID:', BOT_AGENT_ID || '⚠️ Not set (REQUIRED for reassignment detection)');
console.log('HUMAN_AGENT_ID:', HUMAN_AGENT_ID || '⚠️ Not set (for escalation)');
console.log('='.repeat(70) + '\n');

if (!FRESHCHAT_API_KEY || !OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error('❌ Missing required environment variables!');
  process.exit(1);
}

if (!BOT_AGENT_ID) {
  console.warn('⚠️ WARNING: BOT_AGENT_ID not set - reassignment detection will not work!');
}

const openai = new OpenAI({ 
  apiKey: OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID,
  project: process.env.OPENAI_PROJECT_ID
});

// Store conversation threads
const conversationThreads = new Map();

// Store conversations that have been escalated (bot should NOT respond)
const escalatedConversations = new Set();

// Store recent webhooks for debugging
const recentWebhooks = [];
const MAX_STORED_WEBHOOKS = 50;

// ============================================================
// IMAGE/FILE RESPONSE MESSAGE
// ============================================================
const IMAGE_RESPONSE_MESSAGE = `I received your image/file, but I'm unable to process images at the moment.

Please describe your question in text, or reply "Human Representative" to connect with our team.`;

function log(emoji, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${emoji} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

function storeWebhook(webhook) {
  recentWebhooks.unshift({
    timestamp: new Date().toISOString(),
    payload: webhook
  });
  if (recentWebhooks.length > MAX_STORED_WEBHOOKS) {
    recentWebhooks.pop();
  }
}

// ============================================================
// IMPROVED: Strip all citation formats from OpenAI responses
// ============================================================
function stripCitations(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let cleaned = text;

  const inlinePatterns = [
    /\[\^\d+\^\]/g,
    /\[\d+\]/g,
    /【[^】]*】/g,
    /\(Source:[^)]+\)/gi,
    /\[Source:[^\]]+\]/gi,
    /\[\d+:\d+[^\]]*\]/g,
    /\(\d+:\d+[^)]*\)/g,
    /\^\[\d+\]/g,
    /\[\^\d+\]/g,
    /\[\d+[:\d,†]*[^\]]*\]/g
  ];

  inlinePatterns.forEach(pattern => {
    cleaned = cleaned.replace(pattern, '');
  });

  cleaned = cleaned.replace(/^\s*\[\^\d+\^\]:.*$/gm, '');
  cleaned = cleaned.replace(/^\s*【[^】]*】.*$/gm, '');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  cleaned = cleaned.replace(/\s+\n/g, '\n');
  cleaned = cleaned.replace(/\s+\./g, '.');
  cleaned = cleaned.replace(/\.{2,}/g, '.');
  cleaned = cleaned.replace(/\s+([,;:!?])/g, '$1');
  
  return cleaned.trim();
}

// ============================================================
// IMPROVED: Format response for WhatsApp with better spacing
// ============================================================
function formatForWhatsApp(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let formatted = text.trim();

  formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '$1');
  formatted = formatted.replace(/\*(.*?)\*/g, '$1');
  formatted = formatted.replace(/__(.*?)__/g, '$1');
  formatted = formatted.replace(/_(.*?)_/g, '$1');
  formatted = formatted.replace(/`([^`]+)`/g, '$1');
  formatted = formatted.replace(/^#+\s*(.*)$/gm, (_, title) => title.toUpperCase());
  formatted = formatted.replace(/^[\u2022•▪◦-]\s*/gm, '• ');

  // SPACING FIXES
  formatted = formatted.replace(/([^\n•])\n(•\s)/g, '$1\n\n$2');
  formatted = formatted.replace(/(•\s[^\n]+)\n\n+(•\s)/g, '$1\n$2');
  formatted = formatted.replace(/(•\s[^\n]+)\n([^•\n\s])/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(Would you like)/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(Do you want)/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(Do you need)/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(Would you prefer)/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(May I know)/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(Please let me know)/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(I have tried my best)/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(If you want me to continue)/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(If you want me to assist)/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(If you require further)/g, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(Please reply with)/g, '$1\n\n$2');
  formatted = formatted.replace(/(Hello!?|Hi!?|Good morning!?|Good afternoon!?|Good evening!?)\s*\n([^\n])/gi, '$1\n\n$2');
  formatted = formatted.replace(/([^\n])\n(For [A-Z]{2,3} )/g, '$1\n\n$2');
  formatted = formatted.replace(/\n{3,}/g, '\n\n');
  
  formatted = formatted
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();

  return formatted;
}

// ============================================================
// NEW: Extract message content and detect media types
// ============================================================
function extractMessageContent(messageParts) {
  if (!messageParts || !Array.isArray(messageParts)) {
    return { text: null, hasImage: false, hasFile: false, mediaTypes: [] };
  }

  let text = null;
  let hasImage = false;
  let hasFile = false;
  const mediaTypes = [];

  for (const part of messageParts) {
    if (part.text && part.text.content) {
      text = part.text.content;
    }
    
    if (part.image) {
      hasImage = true;
      mediaTypes.push('image');
    }
    
    if (part.file) {
      hasFile = true;
      mediaTypes.push('file');
    }

    if (part.attachment) {
      hasFile = true;
      mediaTypes.push('attachment');
    }

    if (part.video) {
      hasFile = true;
      mediaTypes.push('video');
    }

    if (part.audio) {
      hasFile = true;
      mediaTypes.push('audio');
    }

    if (part.sticker) {
      hasImage = true;
      mediaTypes.push('sticker');
    }
  }

  return { text, hasImage, hasFile, mediaTypes };
}

// Get conversation details from Freshchat API
async function getConversationDetails(conversationId) {
  try {
    const response = await axios.get(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}`,
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    return response.data;
  } catch (error) {
    log('❌', 'Error fetching conversation details:', error.message);
    return null;
  }
}

// ============================================================
// FIXED: Auto-assign conversation to bot agent if unassigned
// Now checks assigned_group_id to avoid stealing from teams
// ============================================================
async function autoAssignToBot(conversationId) {
  try {
    if (!BOT_AGENT_ID) {
      log('⚠️', 'No BOT_AGENT_ID set, cannot auto-assign');
      return false;
    }

    const conversation = await getConversationDetails(conversationId);
    
    if (!conversation) {
      log('⚠️', 'Could not fetch conversation for auto-assign');
      return false;
    }

    const assignedAgentId = conversation.assigned_agent_id;
    const assignedGroupId = conversation.assigned_group_id;

    log('🔍', `Auto-assign check — agent: ${assignedAgentId}, group: ${assignedGroupId}`);

    // If already assigned to bot, skip
    if (assignedAgentId === BOT_AGENT_ID) {
      log('✅', 'Already assigned to bot agent, skipping auto-assign');
      return true;
    }

    // If assigned to a human agent, don't override
    if (assignedAgentId && assignedAgentId !== BOT_AGENT_ID) {
      log('👤', `Already assigned to another agent: ${assignedAgentId}, skipping auto-assign`);
      return false;
    }

    // ============================================================
    // FIX: If assigned to a GROUP (e.g. Admissions Team) but no
    // specific agent, do NOT override — the team owns this chat
    // ============================================================
    if (!assignedAgentId && assignedGroupId) {
      log('👥', `Conversation assigned to group ${assignedGroupId} (no specific agent), skipping auto-assign to bot`);
      return false;
    }

    // Conversation is TRULY UNASSIGNED (no agent AND no group) — assign to bot
    log('🤖', '═'.repeat(70));
    log('🤖', `AUTO-ASSIGNING conversation ${conversationId} to bot agent ${BOT_AGENT_ID}`);
    log('🤖', '═'.repeat(70));

    await axios.put(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}`,
      {
        assigned_agent_id: BOT_AGENT_ID,
        status: 'assigned'
      },
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    log('✅', `Conversation ${conversationId} auto-assigned to bot agent successfully`);
    return true;

  } catch (error) {
    log('❌', 'Auto-assign failed:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    return false;
  }
}

// ============================================================
// FIXED: Check if conversation is assigned to human agent
// Now checks assigned_group_id to recognize team-owned chats
// ============================================================
async function isConversationWithHuman(conversationId) {
  try {
    const conversation = await getConversationDetails(conversationId);
    
    if (!conversation) {
      log('⚠️', 'Could not fetch conversation, assuming bot can respond');
      return false;
    }

    const assignedAgentId = conversation.assigned_agent_id;
    const assignedGroupId = conversation.assigned_group_id;
    
    log('🔍', `Conversation ${conversationId} — agent: ${assignedAgentId}, group: ${assignedGroupId}`);
    log('🤖', `Bot agent ID: ${BOT_AGENT_ID}`);
    log('👤', `Human agent ID: ${HUMAN_AGENT_ID}`);

    // If assigned to human agent, it's with human
    if (assignedAgentId && assignedAgentId !== BOT_AGENT_ID) {
      log('👨‍💼', `Conversation is with human agent (${assignedAgentId})`);
      return true;
    }

    // ============================================================
    // FIX: If assigned to a GROUP (like Admissions Team) but no
    // specific agent has claimed it, it's still human-owned.
    // Bot should NOT take over.
    // ============================================================
    if (!assignedAgentId && assignedGroupId) {
      log('👥', `Conversation is assigned to group ${assignedGroupId} (no specific agent) — treating as human-owned`);
      return true;
    }

    // ============================================================
    // FIX: If conversation is UNASSIGNED (no agent AND no group)
    // but in escalated list, it means human agent resolved it
    // and user reopened. Clear escalated flag, let bot handle it.
    // ============================================================
    if (!assignedAgentId && !assignedGroupId && escalatedConversations.has(conversationId)) {
      log('🔄', '═'.repeat(70));
      log('🔄', 'REOPENED CONVERSATION DETECTED');
      log('🔄', `Conversation ${conversationId} was escalated but is now UNASSIGNED (no agent, no group)`);
      log('🔄', 'Human agent resolved it, user sent new message');
      log('🔄', 'Removing from escalated list - bot will respond');
      log('🔄', '═'.repeat(70));
      escalatedConversations.delete(conversationId);
      return false;
    }

    if (escalatedConversations.has(conversationId) && assignedAgentId === BOT_AGENT_ID) {
      log('🔄', 'Conversation in escalated list but assigned to bot - removing from escalated');
      escalatedConversations.delete(conversationId);
      return false;
    }

    if (escalatedConversations.has(conversationId)) {
      log('🚨', 'Conversation is in escalated list');
      return true;
    }

    log('🤖', 'Conversation is still with bot (or truly unassigned)');
    return false;

  } catch (error) {
    log('❌', 'Error checking conversation assignment:', error.message);
    return false;
  }
}

// Assign conversation to human agent (ESCALATION)
async function escalateToHuman(conversationId) {
  try {
    if (!HUMAN_AGENT_ID) {
      log('⚠️', 'No HUMAN_AGENT_ID set, cannot escalate');
      return false;
    }

    log('🚨', `Escalating conversation ${conversationId} to human agent ${HUMAN_AGENT_ID}`);

    const response = await axios.put(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}`,
      {
        assigned_agent_id: HUMAN_AGENT_ID,
        status: 'assigned'
      },
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    log('✅', `Conversation reassigned to human agent`);
    log('📋', 'Response:', response.data);

    escalatedConversations.add(conversationId);
    conversationThreads.delete(conversationId);
    log('🗑️', `Removed thread for conversation ${conversationId}`);

    return true;

  } catch (error) {
    log('❌', 'Failed to escalate conversation:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    return false;
  }
}

// Return conversation back to bot (DE-ESCALATION)
async function returnToBot(conversationId, sendWelcomeMessage = true, reassignInFreshchat = true) {
  try {
    if (!BOT_AGENT_ID) {
      log('⚠️', 'No BOT_AGENT_ID set, cannot return to bot');
      return false;
    }

    log('🔄', '═'.repeat(70));
    log('🔄', `RETURNING conversation ${conversationId} to bot agent ${BOT_AGENT_ID}`);
    log('🔄', `sendWelcomeMessage: ${sendWelcomeMessage}, reassignInFreshchat: ${reassignInFreshchat}`);
    log('🔄', '═'.repeat(70));

    if (reassignInFreshchat) {
      try {
        const response = await axios.put(
          `${FRESHCHAT_API_URL}/conversations/${conversationId}`,
          {
            assigned_agent_id: BOT_AGENT_ID,
            status: 'assigned'
          },
          {
            headers: {
              'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );
        log('✅', `Conversation reassigned to bot agent via API`);
        log('📋', 'Response:', response.data);
      } catch (apiError) {
        log('⚠️', `API reassignment failed (may already be assigned): ${apiError.message}`);
      }
    } else {
      log('✅', `Conversation already assigned to bot (via Freshchat UI)`);
    }

    const wasEscalated = escalatedConversations.has(conversationId);
    escalatedConversations.delete(conversationId);
    log('✅', `Removed conversation ${conversationId} from escalated list (was escalated: ${wasEscalated})`);

    if (sendWelcomeMessage) {
      try {
        await sendFreshchatMessage(
          conversationId,
          "I'm back! How can I help you today? 😊"
        );
        log('📤', `Sent welcome back message to conversation ${conversationId}`);
      } catch (msgError) {
        log('⚠️', `Failed to send welcome message: ${msgError.message}`);
      }
    }

    log('✅', '═'.repeat(70));
    log('✅', `Bot is now ACTIVE for conversation ${conversationId}`);
    log('✅', '═'.repeat(70));

    return true;

  } catch (error) {
    log('❌', 'Failed to return conversation to bot:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    return false;
  }
}

// Send message to Freshchat
async function sendFreshchatMessage(conversationId, message) {
  try {
    log('📤', `Sending message to conversation: ${conversationId}`);
    log('📝', `Message: ${message.substring(0, 100)}...`);
    
    const payload = BOT_AGENT_ID ? {
      message_parts: [{ text: { content: message } }],
      message_type: 'normal',
      actor_type: 'agent',
      actor_id: BOT_AGENT_ID
    } : {
      message_parts: [{ text: { content: message } }],
      message_type: 'normal',
      actor_type: 'agent'
    };

    const response = await axios.post(
      `${FRESHCHAT_API_URL}/conversations/${conversationId}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${FRESHCHAT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    log('✅', `Message sent successfully!`);
    return response.data;
    
  } catch (error) {
    log('❌', 'Failed to send message:', {
      status: error.response?.status,
      error: error.response?.data || error.message
    });
    throw error;
  }
}

// Get response from OpenAI Assistant
async function getAssistantResponse(userMessage, threadId = null) {
  try {
    log('🤖', `Getting OpenAI response for: "${userMessage}"`);
    
    let thread;
    if (!threadId) {
      thread = await openai.beta.threads.create();
      log('🆕', `Created new thread: ${thread.id}`);
    } else {
      thread = { id: threadId };
      log('♻️', `Using existing thread: ${threadId}`);
    }

    await openai.beta.threads.messages.create(thread.id, {
      role: 'user',
      content: userMessage
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: ASSISTANT_ID
    });

    log('⏳', `Waiting for assistant response (run: ${run.id})...`);

    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    let attempts = 0;
    const maxAttempts = 60;

    while (runStatus.status !== 'completed' && attempts < maxAttempts) {
      if (runStatus.status === 'failed') {
        throw new Error(`Assistant run failed: ${runStatus.last_error?.message}`);
      }
      if (runStatus.status === 'expired') {
        throw new Error('Assistant run expired');
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      attempts++;
      
      if (attempts % 10 === 0) {
        log('⏳', `Still waiting... (${attempts}s, status: ${runStatus.status})`);
      }
    }

    if (runStatus.status !== 'completed') {
      throw new Error(`Assistant timeout after ${attempts}s (status: ${runStatus.status})`);
    }

    log('✅', `Assistant completed in ${attempts} seconds`);

    const messages = await openai.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data
      .filter(msg => msg.role === 'assistant')
      .sort((a, b) => b.created_at - a.created_at)[0];

    if (!assistantMessage) {
      throw new Error('No assistant response found');
    }

    const responseText = assistantMessage.content[0].text.value;
    log('🤖', `Assistant said: ${responseText.substring(0, 200)}...`);

    const escalationKeywords = [
      'Please allow me to connect you to our manager. The response may take 12 to 24 hours due to the high volume of chats. Your patience would be highly appreciated.',
      'human representative',
      'connecting you with a human representative',
      'connecting you to a human representative',
      'connect you to a human representative',
      'connect you with a human representative',
      'speak to my human representative',
      'talk to my human representative',
      'escalate',
      'human agent',
      'real person',
      'allow me to connect with human representative',
      'connect you to human representative',
      'please allow me to connect you to our human representative',
      'i have forwarded your details to our human representative'
    ];

    const needsEscalation = escalationKeywords.some(keyword => 
      responseText.toLowerCase().includes(keyword.toLowerCase())
    );

    if (needsEscalation) {
      log('🚨', 'ESCALATION KEYWORD DETECTED in response!');
    }

    return {
      response: responseText,
      threadId: thread.id,
      needsEscalation
    };

  } catch (error) {
    log('❌', 'OpenAI error:', error.message);
    throw error;
  }
}

// ============================================================
// Handle image/file messages (no LLM call)
// ============================================================
async function handleMediaMessage(conversationId, mediaTypes) {
  try {
    log('🖼️', '═'.repeat(70));
    log('🖼️', `MEDIA MESSAGE DETECTED in conversation: ${conversationId}`);
    log('🖼️', `Media types: ${mediaTypes.join(', ')}`);
    log('🖼️', '═'.repeat(70));

    // Check if conversation is with human
    const isWithHuman = await isConversationWithHuman(conversationId);
    
    if (isWithHuman) {
      log('🛑', 'Conversation is with human agent - bot will NOT respond to media');
      return;
    }

    // Auto-assign to bot if unassigned
    await autoAssignToBot(conversationId);

    // Send the predefined response (no LLM call)
    await sendFreshchatMessage(conversationId, IMAGE_RESPONSE_MESSAGE);

    log('✅', `Sent media acknowledgment message to conversation ${conversationId}`);
    log('✅', '═'.repeat(70));

  } catch (error) {
    log('❌', 'Error handling media message:', error.message);
  }
}

// ============================================================
// Process message — auto-assigns to bot first (if truly unassigned)
// ============================================================
async function processMessage(conversationId, messageContent) {
  try {
    log('🔄', '═'.repeat(70));
    log('🔄', `Processing conversation: ${conversationId}`);
    log('💬', `User message: "${messageContent}"`);

    const isWithHuman = await isConversationWithHuman(conversationId);
    
    if (isWithHuman) {
      log('🛑', '═'.repeat(70));
      log('🛑', 'STOPPING: Conversation is with human agent or team');
      log('🛑', 'Bot will NOT respond');
      log('🛑', '═'.repeat(70));
      return;
    }

    // Auto-assign to bot agent if conversation is truly unassigned
    // (no agent AND no group — won't steal from teams)
    await autoAssignToBot(conversationId);

    log('🤖', 'Conversation is with bot - proceeding with AI response');
    log('🔄', '═'.repeat(70));

    let threadId = conversationThreads.get(conversationId);

    const { response, threadId: newThreadId, needsEscalation } = 
      await getAssistantResponse(messageContent, threadId);

    conversationThreads.set(conversationId, newThreadId);
    log('💾', `Saved thread ${newThreadId} for conversation ${conversationId}`);

    const cleanedResponse = formatForWhatsApp(stripCitations(response));
    await sendFreshchatMessage(conversationId, cleanedResponse);

    if (needsEscalation) {
      log('🚨', '═'.repeat(70));
      log('🚨', 'ESCALATION TRIGGERED!');
      log('🚨', '═'.repeat(70));
      
      const escalated = await escalateToHuman(conversationId);
      
      if (escalated) {
        log('✅', 'Successfully escalated to human agent');
      } else {
        log('❌', 'Escalation failed - bot will continue');
      }
    }

    log('✅', '═'.repeat(70));
    log('✅', `Successfully processed conversation ${conversationId}`);
    log('✅', '═'.repeat(70));

  } catch (error) {
    log('💥', '═'.repeat(70));
    log('💥', `Error processing conversation ${conversationId}`);
    log('💥', 'Error:', error.message);
    log('💥', 'Stack:', error.stack);
    log('💥', '═'.repeat(70));
    
   try {
     if (HUMAN_AGENT_ID) {
       await escalateToHuman(conversationId);
     }
    } catch (fallbackError) {
      log('❌', 'Failed during fallback handling:', fallbackError.message);
    }
  }
}

// Extract conversation ID from various webhook formats
function extractConversationId(data) {
  return data?.conversation?.id ||
         data?.conversation?.conversation_id ||
         data?.message?.conversation_id ||
         data?.assignment?.conversation?.id ||
         data?.assignment?.conversation_id ||
         null;
}

// Extract assigned agent ID from various webhook formats
function extractAssignedAgentId(data, actor) {
  return data?.conversation?.assigned_agent_id ||
         data?.conversation?.assignee?.id ||
         data?.assignment?.to_agent_id ||
         data?.assignment?.assignee?.id ||
         data?.changes?.model_changes?.assigned_agent_id?.[1] ||
         null;
}

// Check if this is an assignment-related event
function isAssignmentEvent(action, data) {
  const assignmentActions = [
    'conversation_update',
    'conversation_assignment',
    'assignment_update',
    'agent_assignment',
    'conversation_reassignment'
  ];
  
  const hasAssignmentData = data?.assignment !== undefined ||
                            data?.conversation?.assigned_agent_id !== undefined ||
                            data?.changes?.model_changes?.assigned_agent_id !== undefined;
  
  return assignmentActions.includes(action) || hasAssignmentData;
}

// Webhook handler for Freshchat
app.post('/freshchat-webhook', async (req, res) => {
  res.status(200).json({ success: true });
  
  const webhookBody = req.body;
  storeWebhook(webhookBody);
  
  log('📥', '═'.repeat(70));
  log('📥', 'WEBHOOK RECEIVED');
  log('📥', '═'.repeat(70));
  log('📋', 'Full webhook body:', webhookBody);
  
  try {
    const { actor, action, data } = webhookBody;
    
    const conversationId = extractConversationId(data);
    const assignedAgentId = extractAssignedAgentId(data, actor);
    
    const changes = data?.changes?.model_changes;
    const newAssignedAgentId = changes?.assigned_agent_id?.[1] || assignedAgentId;
    const oldAssignedAgentId = changes?.assigned_agent_id?.[0];
    
    log('📋', 'Extracted Info:', {
      action,
      actor_type: actor?.actor_type,
      actor_id: actor?.actor_id,
      conversationId,
      assignedAgentId,
      newAssignedAgentId,
      oldAssignedAgentId,
      has_changes: !!changes,
      escalated_count: escalatedConversations.size,
      is_in_escalated: conversationId ? escalatedConversations.has(conversationId) : false,
      bot_agent_id: BOT_AGENT_ID
    });
    
    // =====================================================
    // Handle ALL assignment-related events
    // =====================================================
    if (isAssignmentEvent(action, data) && conversationId) {
      const effectiveAgentId = newAssignedAgentId || assignedAgentId;
      
      log('🔄', '═'.repeat(70));
      log('🔄', 'ASSIGNMENT EVENT DETECTED');
      log('🔄', `Action: ${action}`);
      log('🔄', `Conversation: ${conversationId}`);
      log('🔄', `Old Agent: ${oldAssignedAgentId || 'unknown'}`);
      log('🔄', `New Agent: ${effectiveAgentId}`);
      log('🔄', `Bot Agent ID: ${BOT_AGENT_ID}`);
      log('🔄', `Is in escalated list: ${escalatedConversations.has(conversationId)}`);
      log('🔄', '═'.repeat(70));
      
      if (effectiveAgentId) {
        if (effectiveAgentId === BOT_AGENT_ID) {
          log('🤖', '═'.repeat(70));
          log('🤖', 'CONVERSATION ASSIGNED TO BOT!');
          log('🤖', '═'.repeat(70));
          
          returnToBot(conversationId, true, false)
            .then(success => {
              if (success) {
                log('✅', `Bot is now active for conversation ${conversationId}`);
              } else {
                log('❌', `Failed to activate bot for conversation ${conversationId}`);
              }
            })
            .catch(err => log('❌', 'Error returning to bot:', err.message));
            
        } else {
          log('👤', `Conversation assigned to human agent: ${effectiveAgentId}`);
          if (!escalatedConversations.has(conversationId)) {
            log('➕', 'Adding to escalated list (assigned to human)');
            escalatedConversations.add(conversationId);
          }
        }
      }
    }
    
    // =====================================================
    // Handle manager messages with resolution keywords
    // =====================================================
    if (action === 'message_create' && actor?.actor_type === 'agent') {
      const messageConversationId = data?.message?.conversation_id;
      const messageContent = data?.message?.message_parts?.[0]?.text?.content;
      const agentId = actor?.actor_id;
      
      log('💬', 'Agent message detected:', {
        conversationId: messageConversationId,
        agentId,
        isBotAgent: agentId === BOT_AGENT_ID,
        isEscalated: escalatedConversations.has(messageConversationId),
        messagePreview: messageContent?.substring(0, 50)
      });
      
      if (messageConversationId && messageContent && agentId && agentId !== BOT_AGENT_ID) {
        if (escalatedConversations.has(messageConversationId)) {
          const resolutionKeywords = [
            'it seems like you are unavailable at the moment',
            'i am closing the chat for now',
            'looks like you\'re away at the moment',
            'i\'ll close this chat for now',
            'closing this conversation',
            'returning to bot',
            'handing back to bot',
            'transferring back'
          ];
          
          const messageLower = messageContent.toLowerCase();
          const hasResolutionKeyword = resolutionKeywords.some(keyword => 
            messageLower.includes(keyword.toLowerCase())
          );
          
          if (hasResolutionKeyword) {
            log('✅', '═'.repeat(70));
            log('✅', 'RESOLUTION KEYWORD DETECTED');
            log('✅', `Returning conversation ${messageConversationId} to bot`);
            log('✅', '═'.repeat(70));
            
            returnToBot(messageConversationId, true, true)
              .catch(err => log('❌', 'Failed to return to bot:', err.message));
          }
        }
      }
    }
    
    // =====================================================
    // Handle user messages (with image/file handling)
    // =====================================================
    if (action === 'message_create' && actor?.actor_type === 'user') {
      const messageConversationId = data?.message?.conversation_id;
      const messageParts = data?.message?.message_parts;
      
      // Extract content and detect media
      const { text, hasImage, hasFile, mediaTypes } = extractMessageContent(messageParts);
      
      log('🔍', 'User message data:', {
        conversationId: messageConversationId,
        hasText: !!text,
        textPreview: text?.substring(0, 100),
        hasImage,
        hasFile,
        mediaTypes,
        isEscalated: escalatedConversations.has(messageConversationId)
      });
      
      if (!messageConversationId) {
        log('⚠️', 'Missing conversation ID');
        return;
      }

      // Handle ANY message with media (image/file)
      if (hasImage || hasFile) {
        log('🖼️', `Media detected (${mediaTypes.join(', ')}), sending predefined response`);
        if (text) {
          log('📎', `User also sent text: "${text.substring(0, 50)}..." - ignoring since LLM cannot see image context`);
        }
        handleMediaMessage(messageConversationId, mediaTypes)
          .catch(err => log('❌', 'Error handling media:', err.message));
        return;
      }

      // Process text-only message normally
      if (text) {
        processMessage(messageConversationId, text)
          .catch(err => log('❌', 'Async processing error:', err.message));
      } else {
        log('⚠️', 'No text content found in message');
      }
      
    } else if (!isAssignmentEvent(action, data) && action !== 'message_create') {
      log('ℹ️', `Ignoring webhook: action=${action}`);
    }
    
  } catch (error) {
    log('💥', 'Webhook processing error:', error.message);
    log('💥', 'Stack:', error.stack);
  }
});

// Debug endpoint to view recent webhooks
app.get('/debug/webhooks', (req, res) => {
  res.json({
    count: recentWebhooks.length,
    max_stored: MAX_STORED_WEBHOOKS,
    webhooks: recentWebhooks
  });
});

// Debug endpoint to view state
app.get('/debug/state', (req, res) => {
  res.json({
    escalated_conversations: Array.from(escalatedConversations),
    escalated_count: escalatedConversations.size,
    active_threads: Array.from(conversationThreads.entries()).map(([k, v]) => ({ conversation: k, thread: v })),
    thread_count: conversationThreads.size,
    bot_agent_id: BOT_AGENT_ID,
    human_agent_id: HUMAN_AGENT_ID
  });
});

// Manual force return to bot
app.post('/force-return-to-bot/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  
  log('🔧', `FORCE RETURN TO BOT: ${conversationId}`);
  
  try {
    escalatedConversations.delete(conversationId);
    
    if (BOT_AGENT_ID) {
      try {
        await axios.put(
          `${FRESHCHAT_API_URL}/conversations/${conversationId}`,
          { assigned_agent_id: BOT_AGENT_ID, status: 'assigned' },
          { headers: { 'Authorization': `Bearer ${FRESHCHAT_API_KEY}`, 'Content-Type': 'application/json' } }
        );
      } catch (apiErr) {
        log('⚠️', `API reassignment failed: ${apiErr.message}`);
      }
    }
    
    try {
      await sendFreshchatMessage(conversationId, "I'm back! How can I help you today? 😊");
    } catch (msgErr) {
      log('⚠️', `Failed to send message: ${msgErr.message}`);
    }
    
    res.json({ success: true, message: 'Force returned to bot', conversation_id: conversationId });
    
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Other endpoints
app.post('/test-message', async (req, res) => {
  const { conversation_id, message } = req.body;
  
  if (!conversation_id || !message) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    const isWithHuman = await isConversationWithHuman(conversation_id);
    
    if (isWithHuman) {
      return res.json({ success: false, message: 'Conversation is with human agent', conversation_id });
    }

    let threadId = conversationThreads.get(conversation_id);
    const { response, threadId: newThreadId, needsEscalation } = await getAssistantResponse(message, threadId);
    
    conversationThreads.set(conversation_id, newThreadId);
    
    const cleanedResponse = formatForWhatsApp(stripCitations(response));
    await sendFreshchatMessage(conversation_id, cleanedResponse);
    
    if (needsEscalation) {
      await escalateToHuman(conversation_id);
    }
    
    res.json({ success: true, conversation_id, response: response.substring(0, 200) + '...', escalated: needsEscalation });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/reset-escalation/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  escalatedConversations.delete(conversationId);
  conversationThreads.delete(conversationId);
  res.json({ success: true, message: 'Escalation reset' });
});

app.post('/return-to-bot/:conversationId', async (req, res) => {
  const { conversationId } = req.params;
  const sendMessage = req.query.send_message !== 'false';
  
  try {
    const success = await returnToBot(conversationId, sendMessage, true);
    res.json({ success, conversation_id: conversationId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/escalated', (req, res) => {
  res.json({
    escalated_conversations: Array.from(escalatedConversations),
    count: escalatedConversations.size,
    active_threads: conversationThreads.size
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    version: '9.6.0',
    timestamp: new Date().toISOString(),
    config: {
      freshchat_api_url: FRESHCHAT_API_URL,
      has_bot_agent_id: !!BOT_AGENT_ID,
      bot_agent_id: BOT_AGENT_ID || 'NOT SET'
    },
    stats: {
      activeThreads: conversationThreads.size,
      escalatedConversations: escalatedConversations.size
    }
  });
});

app.get('/test-config', async (req, res) => {
  const results = {
    timestamp: new Date().toISOString(),
    environment: {
      FRESHCHAT_API_KEY: !!FRESHCHAT_API_KEY,
      FRESHCHAT_API_URL: FRESHCHAT_API_URL,
      OPENAI_API_KEY: !!OPENAI_API_KEY,
      ASSISTANT_ID: !!ASSISTANT_ID,
      BOT_AGENT_ID: BOT_AGENT_ID || 'Not set',
      HUMAN_AGENT_ID: HUMAN_AGENT_ID || 'Not set'
    },
    tests: {}
  };

  try {
    await openai.models.list();
    results.tests.openai = '✅ Connected';
  } catch (error) {
    results.tests.openai = `❌ Failed: ${error.message}`;
  }

  try {
    await axios.get(`${FRESHCHAT_API_URL}/agents`, {
      headers: { 'Authorization': `Bearer ${FRESHCHAT_API_KEY}` },
      timeout: 5000
    });
    results.tests.freshchat = '✅ Connected';
  } catch (error) {
    results.tests.freshchat = `❌ Failed: ${error.response?.status}`;
  }

  res.json(results);
});

app.get('/list-agents', async (req, res) => {
  try {
    const response = await axios.get(`${FRESHCHAT_API_URL}/agents`, {
      headers: { 'Authorization': `Bearer ${FRESHCHAT_API_KEY}` },
      timeout: 10000
    });
    res.json({ success: true, agents: response.data.agents || response.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'Freshchat-OpenAI Integration',
    version: '9.6.0',
    status: 'running',
    features: {
      auto_assign: '✅ Auto-assigns truly unassigned conversations to bot agent',
      group_respect: '✅ Respects group/team assignments — bot will NOT steal from teams',
      escalation: '✅ Escalates to human agent on keyword detection',
      de_escalation: '✅ Returns to bot on resolution keywords or manual reassignment',
      reopen_handling: '✅ Properly handles reopened conversations after human resolution',
      media_handling: '✅ Responds to images/files (with or without text) with predefined message'
    },
    important: {
      bot_agent_id: BOT_AGENT_ID || '⚠️ NOT SET - Use /list-agents to find it!'
    },
    endpoints: {
      webhook: 'POST /freshchat-webhook',
      force_return: 'POST /force-return-to-bot/:conversationId',
      debug_webhooks: 'GET /debug/webhooks',
      debug_state: 'GET /debug/state',
      list_agents: 'GET /list-agents'
    }
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 Freshchat-OpenAI Integration v9.6.0');
  console.log('='.repeat(70));
  console.log(`📍 Port: ${PORT}`);
  console.log(`🤖 Bot Agent ID: ${BOT_AGENT_ID || '⚠️ NOT SET'}`);
  console.log(`👤 Human Agent ID: ${HUMAN_AGENT_ID || '⚠️ NOT SET'}`);
  console.log(`✨ Auto-assign: ENABLED (respects group assignments)`);
  console.log(`🔄 Reopen handling: ENABLED`);
  console.log(`🖼️ Media handling: ENABLED (text+image treated same as image-only)`);
  console.log('='.repeat(70));
  console.log('📌 Debug endpoints:');
  console.log('   GET /debug/webhooks - View recent webhooks');
  console.log('   GET /debug/state - View escalation state');
  console.log('   GET /list-agents - Find agent IDs');
  console.log('='.repeat(70) + '\n');
});
