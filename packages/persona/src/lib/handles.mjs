// Account-name rules shared by every path that writes a creator's raw data.

/** What Instagram allows in a username. A name of only dots is rejected where this is used. */
export const HANDLE = /^[A-Za-z0-9._]{1,30}$/;

/** The committed synthetic creators. A real account's data is never written over them, and a creator never takes their handles. */
export const SYNTHETIC_HANDLES = ["junovale", "junofilm"];
