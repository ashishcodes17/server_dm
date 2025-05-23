require("dotenv").config()
const express = require("express")
const bodyParser = require("body-parser")
const { MongoClient, ObjectId } = require("mongodb")
const cors = require("cors")
const fetch = require("node-fetch")

// Add this at the top of the file
const { runMigrations } = require("../lib/migrations")

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
  } catch (error) {
    console.error("Error connecting to MongoDB:", error)
    // Attempt to reconnect after a delay
    setTimeout(connectToMongoDB, 5000)
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
  res.json({ status: "ok", timestamp: new Date() })
})

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

    // CRITICAL FIX: Skip processing if the comment is from our own automation accounts
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

// Find or create a post
async function findOrCreatePost(mediaId) {
  try {
    // Find the post by Instagram media ID
    const post = await db.collection("posts").findOne({ instagramId: mediaId })

    if (post) {
      return post
    }

    // If post not found, try to find a matching account and create the post
    const accounts = await db.collection("instagramAccounts").find({}).toArray()

    for (const account of accounts) {
      try {
        // Validate token before using
        if (!account.accessToken || account.accessToken.includes("undefined") || account.accessToken.includes("null")) {
          console.log(`Invalid token format for account ${account.username}, skipping`)
          continue
        }

        // Try to fetch the post details using the account's token
        const token = account.accessToken
        if (!token) continue

        // Use graph.instagram.com instead of graph.facebook.com as per the documentation
        const response = await fetch(
          `https://graph.instagram.com/${mediaId}?fields=id,permalink,caption&access_token=${token}`,
          { next: { revalidate: 0 } },
        )

        if (response.ok) {
          const postData = await response.json()

          // Create a new post
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
      // Skip if already processed
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
        $or: [
          { postId: post._id },
          { postId: { $exists: false } }, // "any post" automations
          { postId: null }, // "any post" automations
        ],
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

      // CRITICAL FIX: Check if we've already sent ANY DM to this user for ANY automation on this comment
      const existingDM = await db.collection("directMessages").findOne({
        recipientUsername: comment.from?.username,
        commentId: comment.id,
      })

      if (existingDM) {
        console.log(`Already sent a DM to ${comment.from?.username} for this comment, skipping all automations`)
        break // Exit the loop entirely - don't process any more automations for this user
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
      const validToken = instagramAccount.accessToken

      if (!validToken) {
        console.error(`No valid token available for account ${instagramAccount.username}`)
        continue
      }

      // Reply to the comment if enabled (only once per comment)
      if (automation.replyToComments && !automationProcessed) {
        try {
          // Check if we've already replied to this comment
          const existingReply = await db.collection("commentReplies").findOne({
            commentId: comment.id,
          })

          if (!existingReply) {
            await replyToComment(validToken, comment.id, automation.commentReply || "Thanks! Please check your DMs.")

            console.log(`Replied to comment ${comment.id}`)

            // Log the comment reply
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

        if (automation.useOpeningMessage) {
          // Try to send opening message with quick replies
          const openingMessage =
            automation.openingMessage ||
            "Hey there! I'm so happy you're here, thanks so much for your interest 😊\n\nClick below and I'll send you the link in just a sec ✨"

          const buttonText = automation.buttonText || "Send me the link"

          try {
            // Use Instagram Graph API to send message with quick replies
            const response = await fetch(`https://graph.instagram.com/${instagramAccount.instagramId}/messages`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                recipient: { id: comment.from.id },
                messaging_type: "RESPONSE",
                message: {
                  text: openingMessage,
                  quick_replies: [
                    {
                      content_type: "text",
                      title: buttonText,
                      payload: `SEND_CONTENT_${automation._id}`,
                    },
                  ],
                },
                access_token: validToken,
              }),
            })

            if (!response.ok) {
              const errorData = await response.json()
              throw new Error(`Failed to send message with quick replies: ${JSON.stringify(errorData)}`)
            }

            // Log the sent opening DM
            await db.collection("directMessages").insertOne({
              _id: new ObjectId().toString(),
              automationId: automation._id,
              recipientUsername: comment.from?.username || "unknown",
              recipientId: comment.from.id,
              commentId: comment.id,
              message: openingMessage,
              type: "opening",
              status: "sent",
              sentAt: new Date(),
            })

            messageResult = { success: true, method: "quick_replies" }
          } catch (buttonError) {
            console.error(`Error sending DM with quick replies to ${comment.from?.username}:`, buttonError)

            // Try fallback to regular DM with branding
            try {
              let fullMessage = openingMessage + "\n\n" + automation.message

              // CRITICAL FIX: Always add branding
              if (automation.addBranding !== false) {
                fullMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
              }

              // Use Instagram Graph API to send regular message
              const response = await fetch(`https://graph.instagram.com/${instagramAccount.instagramId}/messages`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  recipient: { id: comment.from.id },
                  message: { text: fullMessage },
                  access_token: validToken,
                }),
              })

              if (!response.ok) {
                const errorData = await response.json()
                throw new Error(`Failed to send fallback message: ${JSON.stringify(errorData)}`)
              }

              // Log the sent message
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
            } catch (fallbackError) {
              throw fallbackError
            }
          }
        } else {
          // Send direct message with branding
          let fullMessage = automation.message || "Thank you for your comment!"

          // CRITICAL FIX: Always add branding
          if (automation.addBranding !== false) {
            fullMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
          }

          // Use Instagram Graph API to send message
          const response = await fetch(`https://graph.instagram.com/${instagramAccount.instagramId}/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              recipient: { id: comment.from.id },
              message: { text: fullMessage },
              access_token: validToken,
            }),
          })

          if (!response.ok) {
            const errorData = await response.json()
            throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
          }

          // Log the sent message
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
        }

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

        // CRITICAL FIX: Break after sending one message to prevent duplicates
        break
      } catch (error) {
        console.error(`Error sending message to ${comment.from?.username}:`, error)

        // Log the failed message
        await db.collection("directMessages").insertOne({
          _id: new ObjectId().toString(),
          automationId: automation._id,
          recipientUsername: comment.from?.username || "unknown",
          recipientId: comment.from.id,
          commentId: comment.id,
          message: automation.useOpeningMessage ? automation.openingMessage : automation.message,
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

// Process a button click (quick reply)
async function processButtonClick(data) {
  try {
    const { automationId, senderId, recipientId } = data

    console.log(`Processing button click: automation=${automationId}, sender=${senderId}, recipient=${recipientId}`)

    // Find the automation
    const automation = await db.collection("automations").findOne({ _id: automationId })

    if (!automation) {
      throw new Error(`Automation ${automationId} not found`)
    }

    // Get the Instagram account
    const instagramAccount = await db.collection("instagramAccounts").findOne({
      _id: automation.instagramAccountId,
    })

    if (!instagramAccount) {
      throw new Error(`Instagram account ${automation.instagramAccountId} not found`)
    }

    // Validate token before using
    if (
      !instagramAccount.accessToken ||
      instagramAccount.accessToken.includes("undefined") ||
      instagramAccount.accessToken.includes("null")
    ) {
      throw new Error(`Invalid token format for account ${instagramAccount.username}`)
    }

    // Send the main content message with branding
    let fullMessage = automation.message || "Thank you for your interest!"

    // CRITICAL FIX: Always add branding
    if (automation.addBranding !== false) {
      fullMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
    }

    // Get username from ID
    let username = "user"
    try {
      const token = instagramAccount.accessToken
      const userResponse = await fetch(
        `https://graph.instagram.com/${senderId}?fields=username&access_token=${token}`,
        { cache: "no-store" },
      )
      if (userResponse.ok) {
        const userData = await userResponse.json()
        username = userData.username || username
      }
    } catch (error) {
      console.error("Error getting username:", error)
    }

    // Send the DM using Instagram Graph API
    const dmResponse = await fetch(`https://graph.instagram.com/${instagramAccount.instagramId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text: fullMessage },
        access_token: instagramAccount.accessToken,
      }),
    })

    if (!dmResponse.ok) {
      const errorData = await dmResponse.json()
      throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
    }

    // Log the sent DM
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

    // Update automation stats
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

// Process a message
async function processMessage(messageData) {
  try {
    const { sender, recipient, message, timestamp } = messageData

    console.log(`Processing message from ${sender.id} to ${recipient.id}: "${message?.text || "No text"}"`, {
      timestamp: new Date().toISOString(),
      messageData,
    })

    // CRITICAL FIX: Skip echo messages (messages sent by our automation)
    if (messageData.message?.is_echo) {
      console.log("Skipping echo message (sent by automation)")
      return {
        success: true,
        message: "Skipped echo message",
        processed: false,
      }
    }

    // Find the Instagram account by recipient ID using our new function
    let instagramAccount = null

    // First try to find by instagramId
    instagramAccount = await db.collection("instagramAccounts").findOne({
      instagramId: recipient.id,
    })

    // If not found, try to find by recipientId (for backwards compatibility)
    if (!instagramAccount) {
      instagramAccount = await db.collection("instagramAccounts").findOne({
        recipientId: recipient.id,
      })

      // If found, update the account with the Instagram ID for future lookups
      if (instagramAccount) {
        await db.collection("instagramAccounts").updateOne(
          { _id: instagramAccount._id },
          {
            $set: {
              instagramId: recipient.id,
              updatedAt: new Date(),
            },
          },
        )
      }
    }

    // If still not found, check if we have any accounts at all
    if (!instagramAccount) {
      const accounts = await db.collection("instagramAccounts").find({}).toArray()

      if (accounts.length > 0) {
        // Use the first account as a fallback
        instagramAccount = accounts[0]
        console.log(`Using fallback Instagram account ${instagramAccount.username} for ID ${recipient.id}`)

        // Store this mapping for future use
        await db.collection("instagramIdMappings").updateOne(
          { instagramId: recipient.id },
          {
            $set: {
              accountId: instagramAccount._id,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        )
      }
    }

    if (!instagramAccount) {
      console.log(`No Instagram account found for recipient ID: ${recipient.id}`)
      return {
        success: false,
        message: `Instagram account with ID ${recipient.id} not found`,
      }
    }

    console.log(`Found Instagram account: ${instagramAccount.username} for recipient ID: ${recipient.id}`)

    // Check if this exact message has already been processed
    const existingMessage = await db.collection("incomingMessages").findOne({
      senderId: sender.id,
      message: message?.text || "",
      timestamp: new Date(timestamp || Date.now()),
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

    // Store the message
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
      // Try to get username from Instagram Graph API
      let username = sender.username || "unknown"
      try {
        const token = instagramAccount.accessToken
        if (token && !token.includes("undefined") && !token.includes("null")) {
          const userResponse = await fetch(
            `https://graph.instagram.com/${sender.id}?fields=username&access_token=${token}`,
            {
              cache: "no-store",
              timeout: 5000, // 5 second timeout
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

      // Create new contact
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
      // Update last message
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

    // Add message to chat history
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

    // Process automations with improved error handling and logging
    for (const automation of automations) {
      try {
        // Check if trigger matches
        const triggerMatched =
          automation.triggerKeyword === "any" ||
          (message?.text && message.text.toLowerCase().includes(automation.triggerKeyword.toLowerCase()))

        if (triggerMatched) {
          console.log(`Trigger "${automation.triggerKeyword}" matched in message from ${sender.id}`)

          // CRITICAL FIX: Check if we've already sent a response to this user for this automation
          const existingResponse = await db.collection("directMessages").findOne({
            automationId: automation._id,
            recipientId: sender.id,
            status: "sent",
            sentAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Within last 24 hours
          })

          if (existingResponse) {
            console.log(`Already sent a response to ${sender.id} for automation ${automation._id} in the last 24 hours`)
            continue
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

          // Send the automated response with retry logic
          let responseMessage = automation.message || "Thank you for your message!"

          // CRITICAL FIX: Always add branding
          if (automation.addBranding !== false) {
            responseMessage += `\n\n${automation.brandingMessage || "⚡ Sent via ChatAutoDM — grow your DMs on autopilot"}`
          }

          // Send the DM with retry logic
          let success = false
          let error = null

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              // Send the DM directly using the Instagram Graph API
              const token = instagramAccount.accessToken
              const dmResponse = await fetch(`https://graph.instagram.com/${instagramAccount.instagramId}/messages`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  recipient: { id: sender.id },
                  message: { text: responseMessage },
                  access_token: token,
                }),
                cache: "no-store",
              })

              if (!dmResponse.ok) {
                const errorData = await dmResponse.json()
                throw new Error(`Failed to send direct message: ${JSON.stringify(errorData)}`)
              }

              success = true
              break // Exit retry loop on success
            } catch (sendError) {
              console.error(`Attempt ${attempt} - Error sending automated response to ${sender.id}:`, sendError)
              error = sendError

              // Wait before retry (exponential backoff)
              if (attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
              }
            }
          }

          // Log the result
          if (success) {
            // Log the sent response
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

            // Add to messages collection for UI display
            await db.collection("messages").insertOne({
              _id: autoMessageId,
              contactId: contact._id,
              instagramAccountId: instagramAccount._id,
              fromMe: true,
              message: responseMessage,
              timestamp: new Date(),
              isAutomated: true,
            })

            // Update automation stats
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
            // Log the failed response
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

    // Mark the message as processed
    await db
      .collection("incomingMessages")
      .updateMany(
        { senderId: sender.id, recipientId: recipient.id, processed: false },
        { $set: { processed: true, processedAt: new Date() } },
      )

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

// Reply to a comment
async function replyToComment(accessToken, commentId, replyText) {
  try {
    // Validate token
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      throw new Error("Invalid access token format")
    }

    // Use graph.instagram.com instead of graph.facebook.com
    const response = await fetch(
      `https://graph.instagram.com/${commentId}/replies?message=${encodeURIComponent(replyText)}&access_token=${accessToken}`,
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

// Send a private reply to a comment
async function sendPrivateReply(accessToken, instagramId, commentId, message) {
  try {
    // Validate token
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      throw new Error("Invalid access token format")
    }

    // Use graph.instagram.com as per the documentation
    const response = await fetch(`https://graph.instagram.com/${instagramId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text: message },
        access_token: accessToken,
      }),
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(`Failed to send private reply: ${JSON.stringify(errorData)}`)
    }

    return await response.json()
  } catch (error) {
    console.error("Error sending private reply:", error)
    throw error
  }
}

// Get comments for a post
async function getPostComments(accessToken, postId, since) {
  try {
    // Validate token before using
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      throw new Error("Invalid access token format")
    }

    // Use graph.instagram.com as per the documentation
    const url = `https://graph.instagram.com/${postId}/comments?fields=id,text,username,timestamp,from&access_token=${accessToken}&limit=50${since ? `&since=${since}` : ""}`

    const response = await fetch(url, { cache: "no-store" })

    if (!response.ok) {
      const errorData = await response.json()
      console.error("Instagram API error:", errorData)
      throw new Error(`Failed to fetch post comments: ${JSON.stringify(errorData)}`)
    }

    const data = await response.json()

    return data.data.map((comment) => ({
      id: comment.id,
      text: comment.text || "",
      username: comment.username || comment.from?.username || "unknown",
      timestamp: comment.timestamp,
      from: comment.from || { id: "unknown", username: comment.username || "unknown" },
    }))
  } catch (error) {
    console.error("Error fetching post comments:", error)
    return []
  }
}

// Schedule jobs
function scheduleJobs() {
  // Check for pending messages every minute
  setInterval(async () => {
    try {
      const pendingMessages = await db
        .collection("incomingMessages")
        .find({ processed: false })
        .sort({ createdAt: 1 })
        .limit(20)
        .toArray()

      console.log(`Processing ${pendingMessages.length} pending messages`)

      // CRITICAL FIX: Skip messages that are too old (more than 24 hours)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const recentMessages = pendingMessages.filter((msg) => !msg.timestamp || new Date(msg.timestamp) > oneDayAgo)

      if (recentMessages.length < pendingMessages.length) {
        console.log(`Skipping ${pendingMessages.length - recentMessages.length} messages that are too old`)

        // Mark old messages as processed
        const oldMessageIds = pendingMessages
          .filter((msg) => msg.timestamp && new Date(msg.timestamp) <= oneDayAgo)
          .map((msg) => msg._id)

        if (oldMessageIds.length > 0) {
          await db
            .collection("incomingMessages")
            .updateMany(
              { _id: { $in: oldMessageIds } },
              { $set: { processed: true, processedAt: new Date(), skipped: true, skipReason: "Too old" } },
            )
        }
      }

      for (const message of recentMessages) {
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
    } catch (error) {
      console.error("Error in pending messages job:", error)
    }
  }, 60 * 1000)

  // Check for pending comments every minute
  setInterval(async () => {
    try {
      const pendingComments = await db
        .collection("pendingComments")
        .find({ processed: false })
        .sort({ createdAt: 1 })
        .limit(20)
        .toArray()

      console.log(`Processing ${pendingComments.length} pending comments`)

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

          // Mark as processed
          await db
            .collection("pendingComments")
            .updateOne({ _id: comment._id }, { $set: { processed: true, processedAt: new Date() } })
        } catch (error) {
          console.error(`Error processing pending comment ${comment._id}:`, error)
        }
      }
    } catch (error) {
      console.error("Error in pending comments job:", error)
    }
  }, 60 * 1000)

  console.log("Scheduled jobs initialized")
}

// Process comments for a post
async function processPostComments(accessToken, post, automation, instagramAccount) {
  try {
    // Validate token before using
    if (!accessToken || accessToken.includes("undefined") || accessToken.includes("null")) {
      console.log(`Invalid token format for post ${post.instagramId}, skipping`)
      return
    }

    // Get the last check time
    const lastChecked = automation.lastChecked || new Date(0)

    // Get comments for this post
    const comments = await getPostComments(accessToken, post.instagramId, lastChecked.toISOString())

    console.log(`Found ${comments.length} comments for post ${post.instagramId}`)

    // Process each comment
    for (const comment of comments) {
      try {
        // Check if we've already processed this comment
        const existingComment = await db.collection("comments").findOne({ commentId: comment.id })

        if (existingComment && existingComment.processed) {
          continue
        }

        // Process the comment
        await processComment({
          id: comment.id,
          text: comment.text || "",
          media_id: post.instagramId,
          from: {
            id: comment.from?.id || "unknown",
            username: comment.from?.username || comment.username || "unknown",
          },
        })
      } catch (commentError) {
        console.error(`Error processing comment ${comment.id}:`, commentError)
      }
    }
  } catch (error) {
    console.error(`Error processing post comments for post ${post.instagramId}:`, error)
  }
}

// Update the startServer function
async function startServer() {
  try {
    await connectToMongoDB()

    // Run migrations
    await runMigrations()

    // Schedule jobs
    scheduleJobs()

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`)
    })
  } catch (error) {
    console.error("Error starting server:", error)
    process.exit(1)
  }
}

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully")
  if (client) {
    await client.close()
    console.log("MongoDB connection closed")
  }
  process.exit(0)
})

// Start the server
startServer()
