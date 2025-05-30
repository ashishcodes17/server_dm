require("dotenv").config()
const express = require("express")
const bodyParser = require("body-parser")
const { MongoClient, ObjectId } = require("mongodb")
const cors = require("cors")
const fetch = require("node-fetch")

// Initialize Express app
const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(bodyParser.json({ limit: "10mb" }))

// MongoDB connection with improved options
const MONGODB_URI = process.env.MONGODB_URI
let client
let db

// Keep-alive mechanism
let keepAliveInterval
let healthCheckInterval

// Connect to MongoDB with improved options
async function connectToMongoDB() {
  try {
    client = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 60000,
      maxPoolSize: 10,
      minPoolSize: 5,
      maxIdleTimeMS: 120000,
    })
    await client.connect()
    db = client.db("instaautodm")
    console.log("Connected to MongoDB")

    // Run basic cleanup on startup
    await runBasicCleanup()
  } catch (error) {
    console.error("Error connecting to MongoDB:", error)
    // Attempt to reconnect after a delay
    setTimeout(connectToMongoDB, 5000)
  }
}

// Basic cleanup function
async function runBasicCleanup() {
  try {
    console.log("Running basic cleanup...")

    // Clean up old pending messages (older than 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const oldMessages = await db.collection("incomingMessages").updateMany(
      {
        processed: false,
        timestamp: { $lt: oneDayAgo },
      },
      {
        $set: {
          processed: true,
          processedAt: new Date(),
          skipped: true,
          skipReason: "Too old",
        },
      },
    )

    if (oldMessages.modifiedCount > 0) {
      console.log(`Cleaned up ${oldMessages.modifiedCount} old pending messages`)
    }

    // Fix Instagram account IDs that are set to "unknown"
    await fixInstagramAccountIds()

    console.log("Basic cleanup completed")
  } catch (error) {
    console.error("Error in basic cleanup:", error)
  }
}

// Fix Instagram account IDs
async function fixInstagramAccountIds() {
  try {
    const accounts = await db.collection("instagramAccounts").find({}).toArray()

    for (const account of accounts) {
      if (!account.instagramId || account.instagramId === "unknown") {
        console.log(`Fixing Instagram ID for account: ${account.username}`)

        // Try to get the correct Instagram ID from Facebook API
        if (account.pageAccessToken && account.pageId) {
          try {
            const response = await fetch(
              `https://graph.facebook.com/v18.0/${account.pageId}?fields=instagram_business_account&access_token=${account.pageAccessToken}`,
            )

            if (response.ok) {
              const data = await response.json()
              if (data.instagram_business_account?.id) {
                await db.collection("instagramAccounts").updateOne(
                  { _id: account._id },
                  {
                    $set: {
                      instagramId: data.instagram_business_account.id,
                      updatedAt: new Date(),
                    },
                  },
                )
                console.log(`Updated Instagram ID for ${account.username}: ${data.instagram_business_account.id}`)
              }
            }
          } catch (error) {
            console.error(`Error fixing Instagram ID for ${account.username}:`, error)
          }
        }
      }
    }
  } catch (error) {
    console.error("Error fixing Instagram account IDs:", error)
  }
}

// Authentication middleware
function authenticateRequest(req, res, next) {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  const token = authHeader.split(" ")[1]

  if (token !== process.env.RENDER_SERVER_API_KEY) {
    return res.status(403).json({ error: "Forbidden" })
  }

  next()
}

// Routes
app.get("/", (req, res) => {
  res.send("Instagram Automation Server is running")
})

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  })
})

// Enhanced keep alive endpoint
app.get("/keep-alive", async (req, res) => {
  try {
    console.log("Keep alive ping received at", new Date().toISOString())

    // Perform some database activity to keep connections alive
    await db.collection("serverStatus").updateOne(
      { _id: "keep-alive" },
      {
        $set: {
          lastPing: new Date(),
          status: "alive",
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        },
      },
      { upsert: true },
    )

    // Process any pending messages while we're at it
    const pendingCount = await processPendingMessages()
    const pendingComments = await processPendingComments()

    res.json({
      status: "alive",
      timestamp: new Date(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      pendingMessages: pendingCount,
      pendingComments: pendingComments,
    })
  } catch (error) {
    console.error("Error in keep-alive:", error)
    res.status(500).json({ error: "Keep alive failed" })
  }
})

// Process pending messages
async function processPendingMessages() {
  try {
    const pendingMessages = await db
      .collection("incomingMessages")
      .find({ processed: false })
      .sort({ timestamp: 1 })
      .limit(50)
      .toArray()

    if (pendingMessages.length > 0) {
      console.log(`Processing ${pendingMessages.length} pending messages`)
    }

    for (const message of pendingMessages) {
      try {
        await processMessage({
          sender: { id: message.senderId, username: message.senderUsername },
          recipient: { id: message.recipientId || "unknown" },
          message: { text: message.message },
          timestamp: message.timestamp,
        })
      } catch (error) {
        console.error(`Error processing pending message ${message._id}:`, error)
      }
    }

    return pendingMessages.length
  } catch (error) {
    console.error("Error processing pending messages:", error)
    return 0
  }
}

// Process pending comments
async function processPendingComments() {
  try {
    const pendingComments = await db
      .collection("pendingComments")
      .find({ processed: false })
      .sort({ createdAt: 1 })
      .limit(50)
      .toArray()

    if (pendingComments.length > 0) {
      console.log(`Processing ${pendingComments.length} pending comments`)
    }

    for (const comment of pendingComments) {
      try {
        await processComment({
          id: comment.commentId,
          text: comment.text,
          media_id: comment.mediaId,
          from: {
            id: comment.userId,
            username: comment.username,
          },
        })

        await db
          .collection("pendingComments")
          .updateOne({ _id: comment._id }, { $set: { processed: true, processedAt: new Date() } })
      } catch (error) {
        console.error(`Error processing pending comment ${comment._id}:`, error)
      }
    }

    return pendingComments.length
  } catch (error) {
    console.error("Error processing pending comments:", error)
    return 0
  }
}

// Process events from the main app
app.post("/api/process-event", authenticateRequest, async (req, res) => {
  try {
    const { type, data } = req.body

    console.log(`Processing ${type} event:`, JSON.stringify(data))

    // Log the event
    await db.collection("processedEvents").insertOne({
      type,
      data,
      timestamp: new Date(),
      processed: false,
    })

    let result

    // Process different event types
    switch (type) {
      case "comment":
        result = await processComment(data)
        break
      case "button_click":
        result = await processButtonClick(data)
        break
      case "message":
        result = await processMessage(data)
        break
      default:
        throw new Error(`Unknown event type: ${type}`)
    }

    // Update the event as processed
    await db
      .collection("processedEvents")
      .updateOne(
        { type, "data.id": data.id || data.mid || data.sender?.id },
        { $set: { processed: true, processedAt: new Date(), result } },
      )

    res.json({ success: true, result })
  } catch (error) {
    console.error("Error processing event:", error)

    // Log the error
    await db.collection("serverErrors").insertOne({
      error: String(error),
      stack: error.stack,
      request: req.body,
      timestamp: new Date(),
    })

    res.status(500).json({ error: String(error) })
  }
})

// Process a comment
async function processComment(comment) {
  try {
    console.log(`Processing comment: ${comment.id} on media ${comment.media_id} from ${comment.from?.username}`)

    // Skip processing if the comment is from our own automation accounts
    const automationAccounts = await db.collection("instagramAccounts").find({}).toArray()
    const automationUsernames = automationAccounts.map((acc) => acc.username.toLowerCase())

    if (automationUsernames.includes(comment.from?.username?.toLowerCase())) {
      console.log(`Skipping comment from automation account: ${comment.from?.username}`)
      return {
        success: true,
        message: `Skipped comment from automation account: ${comment.from?.username}`,
        processed: false,
      }
    }

    // Check if this exact comment has already been processed
    const existingComment = await db.collection("comments").findOne({
      commentId: comment.id,
      processed: true,
    })

    if (existingComment) {
      console.log(`Comment ${comment.id} already processed, skipping`)
      return {
        success: true,
        message: `Comment ${comment.id} already processed`,
        processed: false,
      }
    }

    // Find the post in our database
    const post = await findOrCreatePost(comment.media_id)

    if (!post) {
      throw new Error(`Could not find or create post for media ${comment.media_id}`)
    }

    // Find the Instagram account for this post
    const instagramAccount = await db.collection("instagramAccounts").findOne({
      _id: post.instagramAccountId,
    })

    if (!instagramAccount) {
      throw new Error(`Instagram account ${post.instagramAccountId} not found`)
    }

    // Process the comment with automations
    return await processCommentWithAutomations(comment, post, instagramAccount)
  } catch (error) {
    console.error("Error processing comment:", error)
    throw error
  }
}

// Process a comment with automations
async function processCommentWithAutomations(comment, post, instagramAccount) {
  try {
    // Store the comment in the database if it doesn't exist
    const existingComment = await db.collection("comments").findOne({ commentId: comment.id })

    if (!existingComment) {
      await db.collection("comments").insertOne({
        _id: new ObjectId().toString(),
        commentId: comment.id,
        mediaId: comment.media_id,
        postId: post._id,
        text: comment.text || "",
        username: comment.from?.username || "unknown",
        userId: comment.from?.id || "unknown",
        createdAt: new Date(),
        processed: false,
      })
    } else if (existingComment.processed) {
      return {
        success: true,
        message: `Comment ${comment.id} already processed`,
        processed: false,
      }
    }

    // Find automations for this post
    const automations = await db
      .collection("automations")
      .find({
        $or: [{ postId: post._id }, { postId: { $exists: false } }, { postId: null }],
        instagramAccountId: instagramAccount._id,
        active: true,
      })
      .toArray()

    if (automations.length === 0) {
      console.log(`No active automations found for post ${post._id}`)
      return {
        success: true,
        message: `No active automations found for post ${post._id}`,
        processed: false,
      }
    }

    console.log(`Found ${automations.length} automations for post ${post._id}`)

    let messagesSent = 0
    let automationProcessed = false

    // Process each automation (but only send ONE message per user)
    for (const automation of automations) {
      // Check if the comment contains the trigger keyword
      const triggerMatched =
        automation.triggerKeyword === "any" ||
        (comment.text && comment.text.toLowerCase().includes(automation.triggerKeyword.toLowerCase()))

      if (!triggerMatched) {
        console.log(`Trigger "${automation.triggerKeyword}" not matched in comment: ${comment.text}`)
        continue
      }

      console.log(`Trigger "${automation.triggerKeyword}" matched in comment from ${comment.from?.username}`)

      // Check if we've already sent ANY DM to this user for ANY automation on this comment
      const existingDM = await db.collection("directMessages").findOne({
        recipientUsername: comment.from?.username,
        commentId: comment.id,
      })

      if (existingDM) {
        console.log(`Already sent a DM to ${comment.from?.username} for this comment, skipping all automations`)
        break
      }

      // Check rate limiting
      const now = new Date()
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

      const recentDMs = await db.collection("directMessages").countDocuments({
        automationId: automation._id,
        sentAt: { $gte: oneHourAgo },
        status: "sent",
      })

      if (recentDMs >= (automation.rateLimit || 10)) {
        console.log(`Rate limit reached for automation ${automation._id}`)
        continue
      }

      // Validate token before using
      if (
        !instagramAccount.accessToken ||
        instagramAccount.accessToken.includes("undefined") ||
        instagramAccount.accessToken.includes("null")
      ) {
        console.log(`Invalid token format for account ${instagramAccount.username}, skipping automation`)
        continue
      }

      // Get a valid token for this account
      const validToken = instagramAccount.pageAccessToken || instagramAccount.accessToken

      if (!validToken) {
        console.error(`No valid token available for account ${instagramAccount.username}`)
        continue
      }

      // Reply to the comment if enabled (only once per comment)
      if (automation.replyToComments && !automationProcessed) {
        try {
          const existingReply = await db.collection("commentReplies").findOne({
            commentId: comment.id,
          })

          if (!existingReply) {
            await replyToComment(validToken, comment.id, automation.commentReply || "Thanks! Please check your DMs.")

            console.log(`Replied to comment ${comment.id}`)

            await db.collection("commentReplies").insertOne({
              _id: new ObjectId().toString(),
              automationId: automation._id,
              commentId: comment.id,
              username: comment.from?.username || "unknown",
              reply: automation.commentReply || "Thanks! Please check your DMs.",
              status: "sent",
              sentAt: new Date(),
            })
          }
        } catch (error) {
          console.error(`Error replying to comment ${comment.id}:`, error)
        }
      }

      // Send the DM
      try {
        let messageResult

        // Send direct message
        let fullMessage = automation.message || "Thank you for your comment!"

        if (automation.addBranding !== false) {
          fullMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
        }

        const response = await fetch(`https://graph.instagram.com/v18.0/${instagramAccount.instagramId}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${validToken}`,
          },
          body: JSON.stringify({
            recipient: { id: comment.from.id },
            message: { text: fullMessage },
          }),
        })

        if (!response.ok) {
          const errorData = await response.json()
          throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
        }

        await db.collection("directMessages").insertOne({
          _id: new ObjectId().toString(),
          automationId: automation._id,
          recipientUsername: comment.from?.username || "unknown",
          recipientId: comment.from.id,
          commentId: comment.id,
          message: fullMessage,
          type: "direct",
          status: "sent",
          sentAt: new Date(),
        })

        messageResult = { success: true, method: "direct_message" }

        messagesSent++
        automationProcessed = true

        // Update automation stats
        await db.collection("automations").updateOne(
          { _id: automation._id },
          {
            $inc: { totalDMsSent: 1 },
            $set: { lastTriggered: new Date() },
          },
        )

        console.log(
          `Sent message to ${comment.from?.username} via ${messageResult.method} for automation ${automation._id}`,
        )

        break // Only send one message per user
      } catch (error) {
        console.error(`Error sending message to ${comment.from?.username}:`, error)

        await db.collection("directMessages").insertOne({
          _id: new ObjectId().toString(),
          automationId: automation._id,
          recipientUsername: comment.from?.username || "unknown",
          recipientId: comment.from.id,
          commentId: comment.id,
          message: automation.message,
          status: "failed",
          error: String(error),
          sentAt: new Date(),
        })
      }
    }

    // Mark the comment as processed
    await db
      .collection("comments")
      .updateMany({ commentId: comment.id }, { $set: { processed: true, processedAt: new Date() } })

    return {
      success: true,
      message: `Processed comment ${comment.id}`,
      processed: true,
      messagesSent,
    }
  } catch (error) {
    console.error("Error processing comment with automations:", error)
    return {
      success: false,
      message: `Error: ${error.message}`,
      processed: false,
    }
  }
}

// Process a message
async function processMessage(messageData) {
  try {
    const { sender, recipient, message, timestamp } = messageData

    console.log(`Processing message from ${sender.id} to ${recipient.id}: "${message?.text || "No text"}"`)

    if (messageData.message?.is_echo) {
      console.log("Skipping echo message (sent by automation)")
      return {
        success: true,
        message: "Skipped echo message",
        processed: false,
      }
    }

    // Find the Instagram account by recipient ID
    let instagramAccount = await db.collection("instagramAccounts").findOne({
      instagramId: recipient.id,
    })

    if (!instagramAccount) {
      instagramAccount = await db.collection("instagramAccounts").findOne({
        pageId: recipient.id,
      })
    }

    if (!instagramAccount) {
      console.log(`No Instagram account found for recipient ID: ${recipient.id}`)
      return {
        success: false,
        message: `Instagram account with ID ${recipient.id} not found`,
      }
    }

    console.log(`Found Instagram account: ${instagramAccount.username} for recipient ID: ${recipient.id}`)

    const existingMessage = await db.collection("incomingMessages").findOne({
      senderId: sender.id,
      message: message?.text || "",
      processed: true,
    })

    if (existingMessage) {
      console.log("Message already processed, skipping")
      return {
        success: true,
        message: "Message already processed",
        processed: false,
      }
    }

    const messageId = new ObjectId().toString()
    await db.collection("incomingMessages").insertOne({
      _id: messageId,
      instagramAccountId: instagramAccount._id,
      senderId: sender.id,
      senderUsername: sender.username || "unknown",
      message: message?.text || "",
      timestamp: new Date(timestamp || Date.now()),
      processed: false,
    })

    // Find or create contact
    let contact = await db.collection("contacts").findOne({
      instagramAccountId: instagramAccount._id,
      senderId: sender.id,
    })

    if (!contact) {
      let username = sender.username || "unknown"
      try {
        const token = instagramAccount.pageAccessToken || instagramAccount.accessToken
        if (token && !token.includes("undefined") && !token.includes("null")) {
          const userResponse = await fetch(
            `https://graph.instagram.com/v18.0/${sender.id}?fields=username&access_token=${token}`,
            {
              cache: "no-store",
              timeout: 5000,
            },
          )
          if (userResponse.ok) {
            const userData = await userResponse.json()
            username = userData.username || sender.username || "unknown"
          }
        }
      } catch (error) {
        console.error("Error getting username:", error)
      }

      const newContact = {
        _id: new ObjectId().toString(),
        userId: instagramAccount.userId,
        instagramAccountId: instagramAccount._id,
        senderId: sender.id,
        username: username.toLowerCase(),
        displayName: username,
        lastMessage: message?.text || "",
        lastMessageTime: new Date(),
        unread: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }

      await db.collection("contacts").insertOne(newContact)
      contact = newContact
      console.log(`Created new contact: ${username} for sender ID: ${sender.id}`)
    } else {
      await db.collection("contacts").updateOne(
        { _id: contact._id },
        {
          $set: {
            lastMessage: message?.text || "",
            lastMessageTime: new Date(),
            unread: true,
            updatedAt: new Date(),
          },
        },
      )
      console.log(`Updated existing contact: ${contact.username} with new message`)
    }

    await db.collection("messages").insertOne({
      _id: messageId,
      contactId: contact._id,
      instagramAccountId: instagramAccount._id,
      fromMe: false,
      message: message?.text || "",
      timestamp: new Date(),
      read: false,
    })

    // Check for message automations
    const automations = await db
      .collection("automations")
      .find({
        instagramAccountId: instagramAccount._id,
        type: "message",
        active: true,
      })
      .toArray()

    console.log(`Found ${automations.length} active message automations for account ${instagramAccount.username}`)

    let messagesSent = 0

    for (const automation of automations) {
      try {
        const triggerMatched =
          automation.triggerKeyword === "any" ||
          (message?.text && message.text.toLowerCase().includes(automation.triggerKeyword.toLowerCase()))

        if (triggerMatched) {
          console.log(`Trigger "${automation.triggerKeyword}" matched in message from ${sender.id}`)

          const existingResponse = await db.collection("directMessages").findOne({
            automationId: automation._id,
            recipientId: sender.id,
            status: "sent",
            sentAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          })

          if (existingResponse) {
            console.log(`Already sent a response to ${sender.id} for automation ${automation._id} in the last 24 hours`)
            continue
          }

          const now = new Date()
          const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

          const recentDMs = await db.collection("directMessages").countDocuments({
            automationId: automation._id,
            sentAt: { $gte: oneHourAgo },
            status: "sent",
          })

          if (recentDMs >= (automation.rateLimit || 10)) {
            console.log(`Rate limit reached for automation ${automation._id}`)
            continue
          }

          if (
            !instagramAccount.accessToken ||
            instagramAccount.accessToken.includes("undefined") ||
            instagramAccount.accessToken.includes("null")
          ) {
            console.log(`Invalid token format for account ${instagramAccount.username}, skipping automation`)
            continue
          }

          let responseMessage = automation.message || "Thank you for your message!"

          if (automation.addBranding !== false) {
            responseMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
          }

          let success = false
          let error = null

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const token = instagramAccount.pageAccessToken || instagramAccount.accessToken
              const dmResponse = await fetch(
                `https://graph.instagram.com/v18.0/${instagramAccount.instagramId}/messages`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({
                    recipient: { id: sender.id },
                    message: { text: responseMessage },
                  }),
                  cache: "no-store",
                },
              )

              if (!dmResponse.ok) {
                const errorData = await dmResponse.json()
                throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
              }

              success = true
              break
            } catch (sendError) {
              console.error(`Attempt ${attempt} - Error sending automated response to ${sender.id}:`, sendError)
              error = sendError

              if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
              }
            }
          }

          if (success) {
            const autoMessageId = new ObjectId().toString()
            await db.collection("directMessages").insertOne({
              _id: autoMessageId,
              automationId: automation._id,
              userId: instagramAccount.userId,
              instagramAccountId: instagramAccount._id,
              recipientUsername: contact.username,
              recipientId: sender.id,
              message: responseMessage,
              status: "sent",
              sentAt: new Date(),
              isAutomated: true,
            })

            await db.collection("messages").insertOne({
              _id: autoMessageId,
              contactId: contact._id,
              instagramAccountId: instagramAccount._id,
              fromMe: true,
              message: responseMessage,
              timestamp: new Date(),
              isAutomated: true,
            })

            await db.collection("automations").updateOne(
              { _id: automation._id },
              {
                $inc: { totalDMsSent: 1 },
                $set: { lastTriggered: new Date() },
              },
            )

            messagesSent++
            console.log(`Successfully sent automated response to ${contact.username}`)
          } else {
            await db.collection("directMessages").insertOne({
              _id: new ObjectId().toString(),
              automationId: automation._id,
              userId: instagramAccount.userId,
              instagramAccountId: instagramAccount._id,
              recipientUsername: contact.username,
              recipientId: sender.id,
              message: responseMessage,
              status: "failed",
              error: String(error),
              sentAt: new Date(),
              isAutomated: true,
            })
          }
        } else {
          console.log(`Trigger "${automation.triggerKeyword}" not matched in message: ${message?.text || "No text"}`)
        }
      } catch (automationError) {
        console.error(`Error processing automation ${automation._id}:`, automationError)
      }
    }

    await db
      .collection("incomingMessages")
      .updateMany({ senderId: sender.id, processed: false }, { $set: { processed: true, processedAt: new Date() } })

    return {
      success: true,
      message: `Processed message from ${sender.id}`,
      messagesSent,
      contactId: contact._id,
    }
  } catch (error) {
    console.error("Error processing message:", error)
    return {
      success: false,
      message: `Error: ${error.message}`,
      error: String(error),
    }
  }
}

// Process a button click (postback)
async function processButtonClick(data) {
  try {
    const { automationId, senderId, recipientId } = data

    console.log(`Processing button click: automation=${automationId}, sender=${senderId}`)

    const automation = await db.collection("automations").findOne({ _id: automationId })

    if (!automation) {
      throw new Error(`Automation ${automationId} not found`)
    }

    const instagramAccount = await db.collection("instagramAccounts").findOne({
      _id: automation.instagramAccountId,
    })

    if (!instagramAccount) {
      throw new Error(`Instagram account ${automation.instagramAccountId} not found`)
    }

    if (
      !instagramAccount.accessToken ||
      instagramAccount.accessToken.includes("undefined") ||
      instagramAccount.accessToken.includes("null")
    ) {
      throw new Error(`Invalid token format for account ${instagramAccount.username}`)
    }

    let fullMessage = automation.message || "Thank you for your interest!"

    if (automation.addBranding !== false) {
      fullMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
    }

    let username = "user"
    try {
      const token = instagramAccount.pageAccessToken || instagramAccount.accessToken
      const userResponse = await fetch(
        `https://graph.instagram.com/v18.0/${senderId}?fields=username&access_token=${token}`,
        { cache: "no-store" },
      )
      if (userResponse.ok) {
        const userData = await userResponse.json()
        username = userData.username || username
      }
    } catch (error) {
      console.error("Error getting username:", error)
    }

    const dmResponse = await fetch(`https://graph.instagram.com/v18.0/${instagramAccount.instagramId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${instagramAccount.pageAccessToken || instagramAccount.accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text: fullMessage },
      }),
    })

    if (!dmResponse.ok) {
      const errorData = await dmResponse.json()
      throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
    }

    await db.collection("directMessages").insertOne({
      _id: new ObjectId().toString(),
      automationId: automation._id,
      userId: instagramAccount.userId,
      instagramAccountId: instagramAccount._id,
      recipientUsername: username,
      recipientId: senderId,
      message: fullMessage,
      status: "sent",
      sentAt: new Date(),
    })

    await db.collection("automations").updateOne(
      { _id: automation._id },
      {
        $inc: { totalDMsSent: 1 },
        $set: { lastTriggered: new Date() },
      },
    )

    console.log(`Sent content DM to ${username} for automation ${automation._id}`)

    return {
      success: true,
      message: `Sent content DM to ${username} for automation ${automation._id}`,
    }
  } catch (error) {
    console.error("Error processing button click:", error)
    return {
      success: false,
      message: `Error: ${error.message}`,
    }
  }
}

// Find or create a post
async function findOrCreatePost(mediaId) {
  try {
    const post = await db.collection("posts").findOne({ instagramId: mediaId })

    if (post) {
      return post
    }

    const accounts = await db.collection("instagramAccounts").find({}).toArray()

    for (const account of accounts) {
      try {
        if (!account.accessToken || account.accessToken.includes("undefined") || account.accessToken.includes("null")) {
          console.log(`Invalid token format for account ${account.username}, skipping`)
          continue
        }

        const token = account.pageAccessToken || account.accessToken
        if (!token) continue

        const response = await fetch(
          `https://graph.instagram.com/v18.0/${mediaId}?fields=id,permalink,caption&access_token=${token}`,
          { next: { revalidate: 0 } },
        )

        if (response.ok) {
          const postData = await response.json()

          const newPost = {
            _id: new ObjectId().toString(),
            instagramAccountId: account._id,
            instagramId: mediaId,
            caption: postData.caption || "",
            permalink: postData.permalink || "",
            createdAt: new Date(),
            updatedAt: new Date(),
          }

          await db.collection("posts").insertOne(newPost)
          console.log(`Created new post for media ${mediaId}`)

          return newPost
        }
      } catch (error) {
        console.error(`Error fetching post details with account ${account.username}:`, error)
      }
    }

    return null
  } catch (error) {
    console.error("Error finding or creating post:", error)
    return null
  }
}

// Reply to a comment
async function replyToComment(accessToken, commentId, replyText) {
  try {
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      throw new Error("Invalid access token format")
    }

    const response = await fetch(
      `https://graph.instagram.com/v18.0/${commentId}/replies?message=${encodeURIComponent(replyText)}&access_token=${accessToken}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
    )

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(`Failed to reply to comment: ${JSON.stringify(errorData)}`)
    }

    return await response.json()
  } catch (error) {
    console.error("Error replying to comment:", error)
    throw error
  }
}

// Self-ping mechanism to prevent sleeping
function startKeepAlive() {
  const serverUrl = process.env.RENDER_SERVER_URL || "https://server-dm-5909.onrender.com"

  // Self-ping every 25 seconds
  keepAliveInterval = setInterval(async () => {
    try {
      const response = await fetch(`${serverUrl}/keep-alive`)
      if (response.ok) {
        const data = await response.json()
        console.log(`Self-ping successful - Uptime: ${Math.floor(data.uptime)}s`)
      }
    } catch (error) {
      console.error("Self-ping failed:", error)
    }
  }, 25000) // 25 seconds

  // Health check every 2 minutes
  healthCheckInterval = setInterval(
    async () => {
      try {
        // Fix any Instagram account IDs that are still "unknown"
        await fixInstagramAccountIds()

        // Clean up old processed events
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        await db.collection("processedEvents").deleteMany({
          timestamp: { $lt: oneWeekAgo },
        })

        // Update server status
        await db.collection("serverStatus").updateOne(
          { _id: "health-check" },
          {
            $set: {
              lastHealthCheck: new Date(),
              status: "healthy",
              uptime: process.uptime(),
            },
          },
          { upsert: true },
        )

        console.log("Health check completed")
      } catch (error) {
        console.error("Error in health check:", error)
      }
    },
    2 * 60 * 1000,
  ) // 2 minutes

  console.log("Keep-alive mechanism started")
}

// Start the server
async function startServer() {
  try {
    await connectToMongoDB()

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`)

      // Start keep-alive mechanism after 10 seconds
      setTimeout(() => {
        startKeepAlive()
      }, 10000)
    })
  } catch (error) {
    console.error("Error starting server:", error)
    process.exit(1)
  }
}

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully")

  // Clear intervals
  if (keepAliveInterval) clearInterval(keepAliveInterval)
  if (healthCheckInterval) clearInterval(healthCheckInterval)

  if (client) {
    await client.close()
    console.log("MongoDB connection closed")
  }
  process.exit(0)
})

startServer()
