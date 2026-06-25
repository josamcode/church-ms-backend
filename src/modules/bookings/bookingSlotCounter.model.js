const mongoose = require('mongoose');

/**
 * Atomic slot-capacity counter.
 *
 * One document per (bookingTypeId, slotDate, slotTime) tuple.
 * `used` tracks the number of CONFIRMED + COMPLETED bookings in that slot.
 * `capacity` mirrors BookingType.capacity at the time the counter is first
 * seeded; it is NOT updated automatically when BookingType.capacity changes
 * (call reconcileSlotCounters to refresh).
 *
 * Atomic claim:
 *   findOneAndUpdate({ ..., $expr: { $lt: ['$used', '$capacity'] } },
 *                    { $inc: { used: 1 } }, { new: true })
 *   → returns null when full — the caller rejects the booking.
 *
 * Atomic release:
 *   findOneAndUpdate({ ..., used: { $gt: 0 } },
 *                    { $inc: { used: -1 } })
 *   → gracefully no-ops when already zero.
 */
const bookingSlotCounterSchema = new mongoose.Schema(
  {
    bookingTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BookingType',
      required: true,
    },
    slotDate: {
      type: String,
      required: true,
      trim: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    slotTime: {
      type: String,
      default: '',
      trim: true,
    },
    used: {
      type: Number,
      default: 0,
      min: 0,
      required: true,
    },
    capacity: {
      type: Number,
      default: 1,
      min: 1,
      required: true,
    },
  },
  { timestamps: true }
);

// One counter per slot — enforced at the DB level
bookingSlotCounterSchema.index(
  { bookingTypeId: 1, slotDate: 1, slotTime: 1 },
  { unique: true, name: 'slot_key_unique' }
);

const BookingSlotCounter = mongoose.model('BookingSlotCounter', bookingSlotCounterSchema);

module.exports = BookingSlotCounter;
