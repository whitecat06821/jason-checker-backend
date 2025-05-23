import express from 'express';
import { TicketController } from '../controllers/ticket.controller.js';
import * as cheerio from 'cheerio';

const router = express.Router();

// Basic ticket operations
router.post('/url', TicketController.addUrl);
router.get('/', TicketController.getTickets);
router.get('/:id', TicketController.getTicketById);

// Stadium and changes data
router.get('/:id/stadium', TicketController.getStadiumData);
router.get('/:id/changes', TicketController.getChanges);

// Update operations
router.post('/:id/fetch', TicketController.fetchAndUpdateTickets);
router.post('/:id/autocart', TicketController.autoCart);

export default router;