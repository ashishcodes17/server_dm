const express = require("express")
const bodyParser = require("body-parser")
const { MongoClient } = require("mongodb")
const { v4: uuidv4 } = require("uuid")
const axios = require("axios")
const FormData = require("form-data")

require("dotenv").config()

const app = express()
const port = process.env.PORT || 3000

// Middleware to parse JSON bodies
app.use(bodyParser.json())

// MongoDB Connection URL
const mongoUrl = process.env.MONGODB_URI

// Instagram Graph API URL
const instagramGraphApiUrl = "https://graph.facebook.com/v18.0"

// Global variables for MongoDB client and database
let client
let db

// Function to connect to MongoDB
async function connectToMongoDB() {
  try {
    client = new MongoClient(mongoUrl, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    })

    await client.connect()
    console.log("Connected to MongoDB")
    db = client.db(process.env.MONGODB_DB_NAME) // Access the database here
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error)
    throw error // Re-throw the error to prevent the server from starting
  }
}
// Before defining routes, connect to MongoDB
;(async () => {
  try {
    await connectToMongoDB()
    // Start the server only after successfully connecting to MongoDB
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`)
    })
  } catch (error) {
    console.error("Server failed to start due to MongoDB connection error.")
  }
})()

// Function to generate a unique conversation ID
function generateConversationId() {
  return uuidv4()
}

// Endpoint to receive messages from the webhook
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body

    // Checks this is an event from a page subscription
    if (body.object === "page") {
      // Iterates over each entry - there may be multiple if batched
      body.entry.forEach(async (entry) => {
        // Gets the message. entry.messaging is an array, but
        // will only ever contain one message, so we get index 0
        const webhook_event = entry.messaging[0]
        console.log(webhook_event)

        // Get the sender PSID
        const sender_psid = webhook_event.sender.id
        console.log("Sender PSID: " + sender_psid)

        // Check if the event is a message or postback and
        // pass the event to the appropriate handler function
        if (webhook_event.message) {
          await handleMessage(sender_psid, webhook_event.message)
        } else if (webhook_event.postback) {
          handlePostback(sender_psid, webhook_event.postback)
        }
      })

      // Returns a '200 OK' response to all requests
      res.status(200).send("EVENT_RECEIVED")
    } else {
      // Returns a '404 Not Found' if event is not from a page subscription
      res.sendStatus(404)
    }
  } catch (error) {
    console.error("Error processing webhook:", error)
    res.status(500).send("Error processing webhook")
  }
})

// Adds support for GET requests to our webhook
app.get("/webhook", (req, res) => {
  // Your verify token. Should be a random string.
  const VERIFY_TOKEN = process.env.VERIFICATION_TOKEN

  // Parse the query params
  const mode = req.query["hub.mode"]
  const token = req.query["hub.verify_token"]
  const challenge = req.query["hub.challenge"]

  // Checks if a token and mode is in the query string of the request
  if (mode && token) {
    // Checks the mode and token sent is correct
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      // Responds with the challenge token from the request
      console.log("WEBHOOK_VERIFIED")
      res.status(200).send(challenge)
    } else {
      // Responds with '403 Forbidden' if verify tokens do not match
      res.sendStatus(403)
    }
  } else {
    // Returns a '400 Bad Request' if missing parameters
    res.sendStatus(400)
  }
})

// Handles messages events
async function handleMessage(sender_psid, received_message) {
  let response

  // Check if the message contains text
  if (received_message.text) {
    // Create the payload for a basic text message
    response = {
      text: `You sent the message: "${received_message.text}". Now send me an image!`,
    }
  } else if (received_message.attachments) {
    // Get the URL of the message attachment
    const attachment_url = received_message.attachments[0].payload.url
    response = {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              title: "Is this the right picture?",
              subtitle: "Tap a button to answer.",
              image_url: attachment_url,
              buttons: [
                {
                  type: "postback",
                  title: "Yes!",
                  payload: "yes",
                },
                {
                  type: "postback",
                  title: "No!",
                  payload: "no",
                },
              ],
            },
          ],
        },
      },
    }
  }

  // Sends the response message
  await callSendAPI(sender_psid, response)
}

// Handles messaging_postbacks events
function handlePostback(sender_psid, received_postback) {
  let response

  // Get the payload for the postback
  const payload = received_postback.payload

  // Set the response based on the postback payload
  if (payload === "yes") {
    response = { text: "Thanks!" }
  } else if (payload === "no") {
    response = { text: "Oops, try sending another image." }
  }
  // Sends the response message
  callSendAPI(sender_psid, response)
}

// Sends response messages via the Send API
async function callSendAPI(sender_psid, response) {
  // Construct the message body
  const request_body = {
    recipient: {
      id: sender_psid,
    },
    message: response,
  }

  // Send the HTTP request to the Messenger Platform
  try {
    await axios
      .post("https://graph.facebook.com/v18.0/me/messages", request_body, {
        params: {
          access_token: process.env.PAGE_ACCESS_TOKEN,
        },
        headers: {
          "Content-Type": "application/json",
        },
      })
      .then((response) => {
        console.log("message sent!")
      })
      .catch((error) => {
        console.error("Unable to send message:", error)
      })
  } catch (e) {
    console.log(e)
  }
}

// Endpoint to create a new conversation
app.post("/conversations", async (req, res) => {
  try {
    const { instagramId } = req.body

    if (!instagramId) {
      return res.status(400).json({ error: "Instagram ID is required in the request body." })
    }

    const conversationId = generateConversationId()

    // Store the conversation ID in MongoDB
    const result = await db.collection("conversations").insertOne({
      conversationId: conversationId,
      instagramId: instagramId,
      createdAt: new Date(),
    })

    if (result.insertedCount === 1) {
      res.status(201).json({ conversationId: conversationId })
    } else {
      res.status(500).json({ error: "Failed to create conversation in MongoDB." })
    }
  } catch (error) {
    console.error("Error creating conversation:", error)
    res.status(500).json({ error: "Failed to create conversation." })
  }
})

// Endpoint to receive messages and store them in MongoDB
app.post("/messages", async (req, res) => {
  try {
    const messageData = req.body

    if (!messageData) {
      return res.status(400).json({ error: "Message data is required in the request body." })
    }

    await processMessage(messageData)

    res.status(201).json({ message: "Message processed successfully." })
  } catch (error) {
    console.error("Error processing message:", error)
    res.status(500).json({ error: "Failed to process message." })
  }
})

async function processMessage(messageData) {
  try {
    const { sender, recipient, message, timestamp } = messageData

    console.log(`Processing message from ${sender.id} to ${recipient.id}: "${message?.text || "No text"}"`, {
      timestamp: new Date().toISOString(),
      messageData,
    })

    // Make sure we have a database connection
    if (!client || !db) {
      await connectToMongoDB()
    }

    // Find the Instagram account by recipient ID
    const instagramAccount = await db.collection("instagramAccounts").findOne({
      instagramId: recipient.id,
    })

    if (!instagramAccount) {
      console.log(`Instagram account not found for ID: ${recipient.id}`)
      return
    }

    // Find the conversation by Instagram ID
    let conversation = await db.collection("conversations").findOne({
      instagramId: recipient.id,
    })

    // If no conversation exists, create a new one
    if (!conversation) {
      const conversationId = generateConversationId()
      const result = await db.collection("conversations").insertOne({
        conversationId: conversationId,
        instagramId: recipient.id,
        createdAt: new Date(),
      })

      if (result.insertedCount === 1) {
        conversation = {
          conversationId: conversationId,
          instagramId: recipient.id,
        }
        console.log(`New conversation created with ID: ${conversationId}`)
      } else {
        console.error("Failed to create conversation in MongoDB.")
        return
      }
    }

    // Store the message in MongoDB
    const messageToStore = {
      conversationId: conversation.conversationId,
      senderId: sender.id,
      recipientId: recipient.id,
      text: message?.text,
      timestamp: new Date(timestamp),
      createdAt: new Date(),
    }

    const result = await db.collection("messages").insertOne(messageToStore)

    if (result.insertedCount === 1) {
      console.log(`Message stored successfully in conversation ${conversation.conversationId}`)

      // Send the message to the Instagram Graph API
      if (message?.text) {
        await sendMessageToInstagram(instagramAccount.pageId, message.text, process.env.PAGE_ACCESS_TOKEN)
      }
    } else {
      console.error("Failed to store message in MongoDB.")
    }
  } catch (error) {
    console.error("Error in processMessage:", error)
  }
}

async function sendMessageToInstagram(pageId, messageText, pageAccessToken) {
  try {
    const url = `${instagramGraphApiUrl}/${pageId}/messages`

    const requestBody = {
      messaging_type: "RESPONSE",
      recipient: {
        id: pageId,
      },
      message: {
        text: messageText,
      },
    }

    const params = {
      access_token: pageAccessToken,
    }

    const response = await axios.post(url, requestBody, { params })

    if (response.status === 200) {
      console.log("Message sent successfully to Instagram:", response.data)
    } else {
      console.error("Failed to send message to Instagram. Status:", response.status, "Data:", response.data)
    }
  } catch (error) {
    console.error("Error sending message to Instagram:", error)
  }
}
