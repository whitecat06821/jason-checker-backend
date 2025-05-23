import mongoose from 'mongoose';

const TicketUrlSchema = new mongoose.Schema({
  url: { type: String, required: true, unique: true },
  eventId: { type: String, required: true },
  lastChecked: { type: Date, default: Date.now },
  tickets: { type: Array, default: [] },
  stadium: {
    image: { type: String }, // Base64 or URL of stadium image
    layout: { type: Object }, // Stadium layout data
    lastUpdated: { type: Date }
  },
  changes: [{
    timestamp: { type: Date, default: Date.now },
    type: { type: String, enum: ['PRICE_CHANGE', 'AVAILABILITY_CHANGE', 'NEW_SECTION'] },
    details: { type: Object }
  }],
  metadata: {
    lastNetworkData: { type: Object },
    lastSuccessfulFetch: { type: Date },
    fetchCount: { type: Number, default: 0 }
  }
});

// Index for faster queries
TicketUrlSchema.index({ eventId: 1 });
TicketUrlSchema.index({ lastChecked: 1 });

export default mongoose.model('TicketUrl', TicketUrlSchema);