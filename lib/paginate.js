const {HttpError} = require("./errors");

// Pagination is opt-in: with neither ?page nor ?limit this returns null and the caller keeps its old response.
function parsePagination(query, {defaultLimit, maxLimit}) {
  if (query.page === undefined && query.limit === undefined) {
    return null;
  }
  const page = query.page === undefined ? "1" : query.page;
  const limit = query.limit === undefined ? String(defaultLimit) : query.limit;
  if (typeof page !== "string" || !/^\d{1,9}$/.test(page) || Number(page) < 1) {
    throw new HttpError(400, "invalid_pagination", "page must be a positive whole number");
  }
  if (typeof limit !== "string" || !/^\d{1,9}$/.test(limit) || Number(limit) < 1 || Number(limit) > maxLimit) {
    throw new HttpError(400, "invalid_pagination", `limit must be a whole number from 1 to ${maxLimit}`);
  }
  return {page: Number(page), limit: Number(limit)};
}

// A page past the end returns an empty list with correct totals, not an error.
function paginate(list, {page, limit}) {
  const total = list.length;
  const totalPages = Math.ceil(total / limit);
  return {
    items: list.slice((page - 1) * limit, page * limit),
    pagination: {page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1},
  };
}

module.exports = {parsePagination, paginate};
