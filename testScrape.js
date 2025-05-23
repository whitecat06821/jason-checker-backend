import { fetchAvailableTickets } from "./src/services/ticketmaster.service.js";

const url =
  "https://www.ticketmaster.com/denver-broncos-vs-tennessee-titans-denver-colorado-09-07-2025/event/1E00625CD153457B";

fetchAvailableTickets(url)
  .then((tickets) => {
    console.log("Tickets:", tickets);
  })
  .catch((err) => {
    console.error("Error:", err);
  });
