import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import ticketRoutes from "./routes/ticket.routes.js";
import TicketUrl from "./models/TicketUrl.js";
import {
  fetchAvailableTickets,
  ticketEmitter,
  cleanup,
} from "./services/ticketmaster.service.js";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

app.use("/api/tickets", ticketRoutes);

// WebSocket connection handling
io.on("connection", (socket) => {
  console.log("Client connected");

  socket.on("subscribe", (eventId) => {
    socket.join(`event-${eventId}`);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

// Listen for ticket updates and broadcast to connected clients
ticketEmitter.on("ticketUpdate", (data) => {
  io.to(`event-${data.eventId}`).emit("ticketUpdate", data);
});

// Polling for real-time updates (every 5 seconds)
const POLLING_INTERVAL = 5000; // 5 seconds
let isPolling = false;

async function pollTickets() {
  if (isPolling) return;
  isPolling = true;

  try {
    const urls = await TicketUrl.find();
    for (const ticketUrl of urls) {
      try {
        const { tickets, stadiumData, networkData } =
          await fetchAvailableTickets(ticketUrl.url);

        // Update ticket data
        ticketUrl.tickets = tickets;
        ticketUrl.lastChecked = new Date();

        // Update stadium data if available
        if (stadiumData) {
          ticketUrl.stadium = {
            ...ticketUrl.stadium,
            ...stadiumData,
            lastUpdated: new Date(),
          };
        }

        // Track changes
        if (networkData) {
          const changes = detectChanges(
            ticketUrl.metadata.lastNetworkData,
            networkData
          );
          if (changes.length > 0) {
            ticketUrl.changes.push(...changes);
            // Keep only last 100 changes
            if (ticketUrl.changes.length > 100) {
              ticketUrl.changes = ticketUrl.changes.slice(-100);
            }
          }
          ticketUrl.metadata.lastNetworkData = networkData;
        }

        ticketUrl.metadata.lastSuccessfulFetch = new Date();
        ticketUrl.metadata.fetchCount += 1;

        await ticketUrl.save();
        console.log(`Updated tickets for ${ticketUrl.url}`);
      } catch (err) {
        console.error(`Failed to update ${ticketUrl.url}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Polling error:", err);
  } finally {
    isPolling = false;
  }
}

// Start polling
setInterval(pollTickets, POLLING_INTERVAL);

// Connect to MongoDB and start server
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    httpServer.listen(process.env.PORT, () => {
      console.log(`Server running on port ${process.env.PORT}`);
    });
  })
  .catch((err) => console.error("MongoDB connection error:", err));

// Cleanup on server shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received. Cleaning up...");
  await cleanup();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received. Cleaning up...");
  await cleanup();
  process.exit(0);
});

// Helper function to detect changes in ticket data
function detectChanges(oldData, newData) {
  if (!oldData) return [];

  const changes = [];

  // Compare ticket prices and availability
  if (oldData.tickets && newData.tickets) {
    const oldTickets = new Map(oldData.tickets.map((t) => [t.sectionRow, t]));
    const newTickets = new Map(newData.tickets.map((t) => [t.sectionRow, t]));

    // Check for price changes
    for (const [sectionRow, newTicket] of newTickets) {
      const oldTicket = oldTickets.get(sectionRow);
      if (oldTicket && oldTicket.price !== newTicket.price) {
        changes.push({
          type: "PRICE_CHANGE",
          details: {
            sectionRow,
            oldPrice: oldTicket.price,
            newPrice: newTicket.price,
          },
        });
      }
    }

    // Check for new sections
    for (const [sectionRow, newTicket] of newTickets) {
      if (!oldTickets.has(sectionRow)) {
        changes.push({
          type: "NEW_SECTION",
          details: {
            sectionRow,
            price: newTicket.price,
          },
        });
      }
    }
  }

  return changes;
}
