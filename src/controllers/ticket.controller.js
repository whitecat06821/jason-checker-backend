import TicketUrl from '../models/TicketUrl.js';
import { fetchAvailableTickets } from '../services/ticketmaster.service.js';
import { autoCartTicketmaster } from '../services/cart.service.js';

const TICKETMASTER_URL_REGEX = /^https:\/\/www\.ticketmaster\.com\/.+\/event\/[A-Z0-9]+$/;

export const TicketController = {
  addUrl: async (req, res) => {
    const { url } = req.body;

    if (!TICKETMASTER_URL_REGEX.test(url)) {
      return res.status(400).json({ error: 'Invalid Ticketmaster URL' });
    }

    const eventIdMatch = url.match(/event\/([A-Z0-9]+)/i);
    const eventId = eventIdMatch ? eventIdMatch[1] : null;

    if (!eventId) {
      return res.status(400).json({ error: 'Could not extract event ID from URL' });
    }

    let ticketUrl = await TicketUrl.findOne({ url });
    if (!ticketUrl) {
      ticketUrl = await TicketUrl.create({
        url,
        eventId,
        metadata: {
          fetchCount: 0,
          lastSuccessfulFetch: null
        }
      });
    }
    res.json({ success: true, ticketUrl });
  },

  getTickets: async (req, res) => {
    const urls = await TicketUrl.find().sort({ lastChecked: -1 });
    res.json({ success: true, data: urls });
  },

  getTicketById: async (req, res) => {
    const { id } = req.params;
    const ticketUrl = await TicketUrl.findById(id);
    if (!ticketUrl) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ success: true, data: ticketUrl });
  },

  getStadiumData: async (req, res) => {
    const { id } = req.params;
    const ticketUrl = await TicketUrl.findById(id);
    if (!ticketUrl) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({
      success: true,
      data: {
        stadium: ticketUrl.stadium,
        lastUpdated: ticketUrl.stadium?.lastUpdated
      }
    });
  },

  getChanges: async (req, res) => {
    const { id } = req.params;
    const ticketUrl = await TicketUrl.findById(id);
    if (!ticketUrl) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({
      success: true,
      data: {
        changes: ticketUrl.changes,
        lastChecked: ticketUrl.lastChecked
      }
    });
  },

  fetchAndUpdateTickets: async (req, res) => {
    const { id } = req.params;
    const ticketUrl = await TicketUrl.findById(id);
    if (!ticketUrl) {
      return res.status(404).json({ error: 'Not found' });
    }

    try {
      const { tickets, stadiumData, networkData } = await fetchAvailableTickets(ticketUrl.url);

      // Update ticket data
      ticketUrl.tickets = tickets;
      ticketUrl.lastChecked = new Date();

      // Update stadium data if available
      if (stadiumData) {
        ticketUrl.stadium = {
          ...ticketUrl.stadium,
          ...stadiumData,
          lastUpdated: new Date()
        };
      }

      // Track changes
      if (networkData) {
        const changes = detectChanges(ticketUrl.metadata.lastNetworkData, networkData);
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
      res.json({ success: true, data: ticketUrl });
    } catch (err) {
      console.error('Failed to update tickets:', err);
      res.status(500).json({ error: err.message });
    }
  },

  autoCart: async (req, res) => {
    const { id } = req.params;
    const ticketUrl = await TicketUrl.findById(id);
    if (!ticketUrl) {
      return res.status(404).json({ error: 'Not found' });
    }

    try {
      const result = await autoCartTicketmaster(ticketUrl.url, req.body);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
};

// Helper function to detect changes in ticket data
function detectChanges(oldData, newData) {
  if (!oldData) return [];

  const changes = [];

  // Compare ticket prices and availability
  if (oldData.tickets && newData.tickets) {
    const oldTickets = new Map(oldData.tickets.map(t => [t.sectionRow, t]));
    const newTickets = new Map(newData.tickets.map(t => [t.sectionRow, t]));

    // Check for price changes
    for (const [sectionRow, newTicket] of newTickets) {
      const oldTicket = oldTickets.get(sectionRow);
      if (oldTicket && oldTicket.price !== newTicket.price) {
        changes.push({
          type: 'PRICE_CHANGE',
          details: {
            sectionRow,
            oldPrice: oldTicket.price,
            newPrice: newTicket.price
          }
        });
      }
    }

    // Check for new sections
    for (const [sectionRow, newTicket] of newTickets) {
      if (!oldTickets.has(sectionRow)) {
        changes.push({
          type: 'NEW_SECTION',
          details: {
            sectionRow,
            price: newTicket.price
          }
        });
      }
    }
  }

  return changes;
}