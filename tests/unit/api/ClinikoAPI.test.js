const ClinikoAPI = require('../../../src/api/ClinikoAPI');
jest.mock('axios');

const axios = require('axios');

describe('ClinikoAPI', () => {
  test('should fetch locations', async () => {
    axios.get.mockResolvedValue({ data: [{ id: 1, name: 'Clinic A' }] });
    const locations = await ClinikoAPI.getLocations();
    expect(locations).toHaveLength(1);
    expect(locations[0].name).toBe('Clinic A');
  });
});
